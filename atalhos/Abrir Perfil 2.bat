@echo off
rem Abre uma SEGUNDA copia do PokeIdle Multi (Perfil 2): outras 4 contas, outros logins.
rem Deixe este arquivo na mesma pasta do "PokeIdle Multi <versao>.exe".
cd /d "%~dp0"
for /f "delims=" %%f in ('dir /b /o-d "PokeIdle Multi 1*.exe"') do (
  start "" "%%f" --perfil=2
  goto :eof
)
echo Nao achei o "PokeIdle Multi <versao>.exe" nesta pasta.
pause
