@echo off
chcp 65001 >nul
title PokeIdle Multi
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js nao esta instalado.
  echo  Baixe a versao LTS em https://nodejs.org , instale e rode este arquivo de novo.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\electron (
  echo Instalando o PokeIdle Multi pela primeira vez ^(so acontece uma vez^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo Falhou a instalacao. & pause & exit /b 1 )
)
start "" /b npx electron .
exit /b 0
