@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Canal Dark
cd /d "%~dp0"

set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo.
echo ==========================================
echo   CANAL DARK
echo ==========================================
echo.

rem ---------------------------------------------------------------------------
rem 1) Node.js
rem ---------------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado.
  echo        Instale em https://nodejs.org ^(versao LTS^) e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
echo [ok] Node.js %NODE_VERSION%

rem ---------------------------------------------------------------------------
rem 2) Dependencias do app
rem ---------------------------------------------------------------------------
if not exist "node_modules" (
  echo [..] Instalando dependencias do app ^(primeira vez, pode demorar^)...
  call npm install
  if errorlevel 1 (
    echo [ERRO] Falha no npm install. Veja o erro acima.
    pause
    exit /b 1
  )
)
echo [ok] Dependencias do app

rem ---------------------------------------------------------------------------
rem 3) FFmpeg
rem ---------------------------------------------------------------------------
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [aviso] FFmpeg nao esta no PATH - o render de video nao vai funcionar.
  echo         Instale com: winget install Gyan.FFmpeg
) else (
  echo [ok] FFmpeg
)

rem ---------------------------------------------------------------------------
rem 4) Python + voz Kokoro (opcional)
rem ---------------------------------------------------------------------------
set "PY_OK=0"
where python >nul 2>&1
if not errorlevel 1 (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
  if not errorlevel 1 (
    set "PY_OK=1"
    python -c "import kokoro_onnx, soundfile, numpy" >nul 2>&1
    if errorlevel 1 (
      echo [..] Instalando dependencias de voz...
      python -m pip install --disable-pip-version-check --no-input -r requirements.txt >nul 2>&1
      if errorlevel 1 set "PY_OK=0"
    )
    if "%PY_OK%"=="1" if not exist "kokoro-v1.0.onnx" (
      echo [..] Baixando modelos de voz ^(~354 MB, so na primeira vez^)...
      python python\download_models.py
      if errorlevel 1 set "PY_OK=0"
    )
  )
)
if "%PY_OK%"=="1" (
  echo [ok] Voz Kokoro pronta
) else (
  echo [aviso] Voz Kokoro indisponivel - o app usa Gemini/Edge.
)

rem ---------------------------------------------------------------------------
rem 5) Modo: producao (padrao) ou desenvolvimento (--dev)
rem ---------------------------------------------------------------------------
set "MODO=producao"
if /i "%~1"=="--dev" set "MODO=dev"
if /i "%~1"=="dev" set "MODO=dev"
echo [ok] Modo: %MODO%

rem ---------------------------------------------------------------------------
rem 6) Servidor ja rodando?
rem ---------------------------------------------------------------------------
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [ok] O app ja esta rodando em %URL%
  if not defined CANAL_DARK_NO_BROWSER (
    start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "scripts\abrir-app.ps1" "%URL%"
  )
  echo.
  echo Feche a janela do servidor para parar.
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

rem ---------------------------------------------------------------------------
rem 7) Build (producao) so quando necessario
rem ---------------------------------------------------------------------------
if "%MODO%"=="producao" (
  set "PRECISA_BUILD=0"
  if not exist "dist\canal-dark\server\server.mjs" set "PRECISA_BUILD=1"
  if exist "dist\canal-dark\server\server.mjs" (
    for /f %%d in ('powershell -NoProfile -Command "$s=(Get-ChildItem src -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime; $b=(Get-Item 'dist/canal-dark/server/server.mjs').LastWriteTime; if($s -gt $b){'1'}else{'0'}"') do set "PRECISA_BUILD=%%d"
  )
  if "%PRECISA_BUILD%"=="1" (
    echo [..] Compilando o app ^(só quando o código muda^)...
    call npm run build
    if errorlevel 1 (
      echo [ERRO] Falha no build.
      pause
      exit /b 1
    )
  )
)

echo.
echo ==========================================
echo   App: %URL%
echo   Voz do canal: aba "Midia e Voz"
echo   Terminal: render.bat para gerar sem navegador
echo   Feche esta janela para parar o servidor.
echo ==========================================
echo.

if not defined CANAL_DARK_NO_BROWSER (
  start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "scripts\abrir-app.ps1" "%URL%"
)

if "%MODO%"=="dev" (
  call npm run dev
) else (
  set "PORT=%PORT%"
  call npm start
)

echo.
echo Servidor encerrado.
endlocal
