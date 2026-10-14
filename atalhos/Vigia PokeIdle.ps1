# Vigia do PokeIdle Multi - roda pelo Agendador de Tarefas do Windows a cada 10 min (escondido).
# Reabre o app (perfil normal) quando:
#   - o app nao esta aberto (fechou/caiu);
#   - o app travou: sem sinal de vida (status.json) ha mais de 5 min;
#   - a conta do Bekazin esta deslogada ha mais de 3 min.
# Para reabrir: mata SO o app do perfil normal (nao mexe no Perfil 2, na Lite nem no Basico) e abre o
# "PokeIdle Multi 1.x.y.exe" mais novo desta pasta.
# Deslogado que nao volta depois de 3 reaberturas seguidas: para de reabrir e so avisa (senao ficaria
# reabrindo a cada 10 min sem adiantar). Volta ao normal quando o Bekazin logar de novo.
# Log: %APPDATA%\PokeIdle Multi\vigia.log
# -Teste: so diz o que faria (nao mata nem abre nada, nao grava estado).

param([switch]$Teste)
$ErrorActionPreference = 'Continue'
$NICK = 'bekazin'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$ud = Join-Path $env:APPDATA 'PokeIdle Multi'
$arqLog = Join-Path $ud 'vigia.log'
$arqEstado = Join-Path $ud 'vigia-estado.json'
$agora = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

function Log($t) {
  if ($Teste) { Write-Output "TESTE - $t"; return }
  try {
    if ((Test-Path $arqLog) -and (Get-Item $arqLog).Length -gt 512KB) { Move-Item $arqLog "$arqLog.old" -Force }
    Add-Content -Path $arqLog -Value ("{0}  {1}" -f (Get-Date -Format 'dd/MM HH:mm:ss'), $t) -Encoding UTF8
  } catch {}
}

$estado = @{ seguidasDeslogado = 0 }
try { if (Test-Path $arqEstado) { $j = Get-Content $arqEstado -Raw -ErrorAction Stop | ConvertFrom-Json; $estado.seguidasDeslogado = [int]$j.seguidasDeslogado } } catch {}
function SalvarEstado { if ($Teste) { return }; try { $estado | ConvertTo-Json | Set-Content -Path $arqEstado -Encoding UTF8 } catch {} }

# processos do app do perfil NORMAL: o lancador portatil e o app descompactado (+ filhos)
$todos = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'PokeIdle Multi*.exe' -and $_.Name -notmatch 'Lite|Basico' })
$principais = @($todos | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--perfil=' })

$st = $null
try { $st = Get-Content (Join-Path $ud 'status.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch {}

$motivo = $null
if ($principais.Count -eq 0) {
  $motivo = 'app fechado'
} else {
  $inicio = ($principais | ForEach-Object { $_.CreationDate } | Sort-Object | Select-Object -First 1)
  $idadeMin = ((Get-Date) - $inicio).TotalMinutes
  if ($idadeMin -lt 4) { Log "ok (app aberto ha $([int]($idadeMin * 60)) s - espera o 1o sinal)"; exit 0 }
  if (-not $st -or ($agora - [int64]$st.em) -gt 5 * 60000) {
    $semSinal = if ($st) { [int](($agora - [int64]$st.em) / 60000) } else { '?' }
    $motivo = "app travado (sem sinal ha $semSinal min)"
  } else {
    $bek = @($st.contas | Where-Object { "$($_.nickUltimo)".ToLower() -eq $NICK })
    if ($bek.Count -eq 0) {
      Log "ok (nao sei qual conta e a do $NICK ainda - ela precisa ter logado uma vez nesta versao)"
    } elseif ($bek[0].logado) {
      if ($estado.seguidasDeslogado -gt 0) { $estado.seguidasDeslogado = 0; SalvarEstado }
      Log "ok ($NICK logado na conta $($bek[0].n))"
    } elseif ($bek[0].deslogadoDesde -and ($agora - [int64]$bek[0].deslogadoDesde) -ge 3 * 60000) {
      $min = [int](($agora - [int64]$bek[0].deslogadoDesde) / 60000)
      if ($estado.seguidasDeslogado -ge 3) {
        Log "ATENCAO: $NICK deslogado ha $min min e ja reabri 3 vezes seguidas sem voltar - nao reabro mais; faca o login na mao"
        exit 0
      }
      $motivo = "$NICK deslogado ha $min min (conta $($bek[0].n))"
      $estado.seguidasDeslogado++
      SalvarEstado
    } else {
      Log "ok ($NICK caiu ha menos de 3 min - pode ser so reconexao)"
    }
  }
}
if (-not $motivo) { exit 0 }

# o exe para abrir: o mais novo desta pasta (sem Lite/Basico); senao, o que estava aberto
$exe = Get-ChildItem -Path $pasta -Filter 'PokeIdle Multi 1.*.exe' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch 'Lite|Basico' } |
  Sort-Object { [version](($_.BaseName -replace '^PokeIdle Multi ', '') -replace '[^\d.]', '') } -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $exe -and $st -and $st.exe -and (Test-Path $st.exe)) { $exe = $st.exe }
if (-not $exe) { Log "$motivo - mas NAO achei o exe do PokeIdle Multi em $pasta"; exit 1 }

if ($Teste) { Write-Output "TESTE - reabriria: $motivo -> $exe (mataria os pids: $(($principais | ForEach-Object { $_.ProcessId }) -join ', '))"; exit 0 }
Log "REABRINDO: $motivo"

# Todos os processos do app do perfil NORMAL (lancador, app, Cockpits do Rotom, renderers...).
function ProcsDoPerfil {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -like 'PokeIdle Multi*.exe' -and $_.Name -notmatch 'Lite|Basico' -and (
      ($_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--perfil=') -or
      $_.CommandLine -match 'user-data-dir="?[^"]*\PokeIdle Multi"')
  })
}
# Mata tudo e confere que nao sobrou nada: um processo esquecido (ex.: com o Cockpit do Rotom aberto)
# segura a trava de "uma instancia so" e o app novo fecha na hora.
function MatarTudo {
  for ($i = 0; $i -lt 6; $i++) {
    $ps = ProcsDoPerfil
    if ($ps.Count -eq 0) { return $true }
    foreach ($p in $ps) { & taskkill.exe /PID $p.ProcessId /T /F *> $null }
    Start-Sleep -Seconds 2
  }
  $resto = ProcsDoPerfil
  if ($resto.Count) { Log "AINDA vivos depois de matar: $(($resto | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', ')"; return $false }
  return $true
}

for ($tentativa = 1; $tentativa -le 2; $tentativa++) {
  if (-not (MatarTudo)) { Log "nao consegui fechar o app antigo - nao abro outro por cima"; exit 1 }
  Start-Sleep -Seconds 2
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
  Log "abri $exe (tentativa $tentativa) - conferindo se ficou de pe..."
  Start-Sleep -Seconds 30
  $vivo = @(ProcsDoPerfil | Where-Object { $_.CommandLine -notmatch '--type=' })
  if ($vivo.Count) { Log "ok: app aberto (pid $(($vivo | ForEach-Object { $_.ProcessId }) -join ', '))"; exit 0 }
  Log "o app novo NAO ficou aberto - matando sobras e tentando de novo"
}
Log "FALHOU: o app nao ficou aberto depois de 2 tentativas"
exit 1
