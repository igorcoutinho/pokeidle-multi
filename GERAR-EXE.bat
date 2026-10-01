@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\electron call npm install --no-audit --no-fund
call npm run build
echo.
echo Pronto: o executavel portatil esta na pasta "dist".
pause
