@echo off
rem Desliga o vigia do PokeIdle Multi (apaga a tarefa do Agendador e a entrada da Inicializacao). O app continua aberto.
schtasks /Delete /F /TN "PokeIdle Multi - Vigia"
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PokeIdle Multi - Vigia.vbs" 2>nul
echo.
echo Vigia DESLIGADO (nao roda mais a cada 10 min nem ao ligar o Windows).
pause
