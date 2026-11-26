@echo off
chcp 65001 >nul
title Canal Dark - desenvolvimento
cd /d "%~dp0"

rem Se o servidor ja estiver rodando, so abre o navegador.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Servidor ja esta rodando em http://localhost:3000
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Process 'http://localhost:3000'"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo Falha no npm install. Veja o erro acima.
    pause
    exit /b 1
  )
)

echo.
echo ==========================================
echo   Canal Dark - http://localhost:3000
echo   Feche esta janela para parar o servidor.
echo ==========================================
echo.

rem Abre o navegador quando o Angular terminar de compilar.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 15; Start-Process 'http://localhost:3000'"

call npm run dev
pause
