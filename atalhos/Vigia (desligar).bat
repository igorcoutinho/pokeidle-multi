@echo off
rem Desliga o vigia do PokeIdle Multi (apaga a tarefa do Agendador). O app continua aberto.
schtasks /Delete /F /TN "PokeIdle Multi - Vigia"
echo.
echo Vigia DESLIGADO.
pause
