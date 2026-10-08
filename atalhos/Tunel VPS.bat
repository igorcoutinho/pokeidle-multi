@echo off
rem Tunel SSH ate a VPS: cria um proxy em socks5://127.0.0.1:1080 que sai pelo IP da VPS.
rem Na VPS (Windows Server) o "OpenSSH Server" precisa estar ligado (veja o LEIA-ME).
rem 1) Troque o IP e o usuario abaixo.  2) Deixe esta janela ABERTA enquanto o Perfil 2 joga.
set VPS_IP=COLOQUE_O_IP_DA_VPS
set VPS_USUARIO=Administrator
title Tunel VPS %VPS_IP% (nao feche)
:loop
echo [%time%] conectando em %VPS_USUARIO%@%VPS_IP% ...
ssh -N -D 127.0.0.1:1080 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes %VPS_USUARIO%@%VPS_IP%
echo [%time%] o tunel caiu - reconectando em 5 s (Ctrl+C para parar)
timeout /t 5 >nul
goto loop
