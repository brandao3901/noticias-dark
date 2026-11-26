@echo off
chcp 65001 >nul
title Canal Dark - producao
cd /d "%~dp0"

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Servidor ja esta rodando em http://localhost:3000
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Process 'http://localhost:3000'"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)

echo Compilando (leva alguns segundos)...
call npm run build
if errorlevel 1 (
  echo.
  echo Falha no build. Veja o erro acima.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo   Canal Dark - http://localhost:3000
echo   Modo producao. Feche a janela para parar.
echo ==========================================
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"

call npm start
pause
