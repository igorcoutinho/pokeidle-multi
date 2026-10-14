@echo off
rem Liga o vigia do PokeIdle Multi: o Agendador de Tarefas do Windows roda o "Vigia PokeIdle.ps1"
rem desta pasta a cada 10 min, escondido. Ele reabre o app se fechar, travar ou se o Bekazin deslogar.
rem Para desligar: "Vigia (desligar).bat". Log: %APPDATA%\PokeIdle Multi\vigia.log
cd /d "%~dp0"
> "%~dp0vigia.vbs" echo CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0Vigia PokeIdle.ps1""", 0, False
schtasks /Create /F /TN "PokeIdle Multi - Vigia" /SC MINUTE /MO 10 /TR "wscript.exe \"%~dp0vigia.vbs\"" /IT
if errorlevel 1 (echo Nao deu para criar a tarefa. & pause & exit /b 1)
echo.
echo Vigia LIGADO: confere o PokeIdle Multi a cada 10 min.
echo Log: %APPDATA%\PokeIdle Multi\vigia.log
pause
