@echo off
rem Liga o vigia do PokeIdle Multi:
rem  - tarefa do Agendador do Windows que roda o "Vigia PokeIdle.ps1" desta pasta a cada 10 min, escondido;
rem  - e na Inicializacao do Windows: ao entrar no Windows, espera 1 min e roda o vigia (abre o app).
rem Ele reabre o app se fechar, travar ou se o Bekazin deslogar.
rem Para desligar: "Vigia (desligar).bat". Log: %APPDATA%\PokeIdle Multi\vigia.log
cd /d "%~dp0"
> "%~dp0vigia.vbs" echo CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0Vigia PokeIdle.ps1""", 0, False
schtasks /Create /F /TN "PokeIdle Multi - Vigia" /SC MINUTE /MO 10 /TR "wscript.exe \"%~dp0vigia.vbs\"" /IT
if errorlevel 1 (echo Nao deu para criar a tarefa. & pause & exit /b 1)
set "INI=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PokeIdle Multi - Vigia.vbs"
> "%INI%" echo ' Vigia do PokeIdle Multi: ao entrar no Windows, espera 1 min e roda o vigia (que abre o app).
>> "%INI%" echo WScript.Sleep 60000
>> "%INI%" echo CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0Vigia PokeIdle.ps1""", 0, False
echo.
echo Vigia LIGADO: confere o PokeIdle Multi a cada 10 min e abre o app ao entrar no Windows.
echo Log: %APPDATA%\PokeIdle Multi\vigia.log
pause
