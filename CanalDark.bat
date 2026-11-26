@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Canal Dark
cd /d "%~dp0"

set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo.
echo ==========================================
echo   CANAL DARK - inicializacao completa
echo ==========================================
echo.

rem ---------------------------------------------------------------------------
rem 1) Node.js
rem ---------------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado.
  echo        Instale em https://nodejs.org ^(versao LTS^) e rode este arquivo de novo.
  goto :fim_com_erro
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
    goto :fim_com_erro
  )
)
echo [ok] Dependencias do app

rem ---------------------------------------------------------------------------
rem 3) FFmpeg (usado no render)
rem ---------------------------------------------------------------------------
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [aviso] FFmpeg nao esta no PATH - o render de video nao vai funcionar.
  echo         Instale com: winget install Gyan.FFmpeg
) else (
  echo [ok] FFmpeg
)

rem ---------------------------------------------------------------------------
rem 4) Python + voz Kokoro (opcional: sem isso o app usa Gemini/Edge)
rem ---------------------------------------------------------------------------
set "PY_OK=0"
where python >nul 2>&1
if errorlevel 1 (
  echo [aviso] Python nao encontrado - voz Kokoro desativada, o app usa Gemini/Edge.
  goto :python_pronto
)

python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
  echo [aviso] Python 3.10+ necessario para o Kokoro - voz Kokoro desativada.
  goto :python_pronto
)

set "PY_OK=1"
python -c "import kokoro_onnx, soundfile, numpy" >nul 2>&1
if errorlevel 1 (
  echo [..] Instalando dependencias de voz ^(kokoro-onnx, soundfile, numpy^)...
  python -m pip install --disable-pip-version-check --no-input -r requirements.txt
  if errorlevel 1 (
    echo [aviso] Falha ao instalar as dependencias de voz - seguindo sem Kokoro.
    set "PY_OK=0"
  )
)

if "%PY_OK%"=="1" (
  if not exist "kokoro-v1.0.onnx" (
    echo [..] Baixando modelos de voz ^(~354 MB, so na primeira vez^)...
    python python\download_models.py
    if errorlevel 1 (
      echo [aviso] Falha no download dos modelos - seguindo sem Kokoro.
      set "PY_OK=0"
    )
  )
  if not exist "voices-v1.0.bin" (
    python python\download_models.py
  )
)

if "%PY_OK%"=="1" (
  echo [ok] Voz Kokoro pronta ^(config.json^)
) else (
  echo [aviso] Voz Kokoro indisponivel - o app continua com Gemini/Edge.
)

:python_pronto

rem ---------------------------------------------------------------------------
rem 5) Servidor ja rodando?
rem ---------------------------------------------------------------------------
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [ok] O app ja esta rodando em %URL%
  if not defined CANAL_DARK_NO_BROWSER (
    start "" "%URL%"
  )
  echo.
  echo Feche a janela do servidor para parar.
  ping -n 4 127.0.0.1 >nul
  goto :fim
)

rem ---------------------------------------------------------------------------
rem 6) Abre o app
rem ---------------------------------------------------------------------------
echo.
echo ==========================================
echo   App: %URL%
echo   Voz do canal: aba "Midia e Voz"
echo   Feche esta janela para parar o servidor.
echo ==========================================
echo.

if not defined CANAL_DARK_NO_BROWSER (
  rem Abre o navegador quando o Angular terminar de compilar.
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 14; Start-Process '%URL%'"
)

call npm run dev

echo.
echo Servidor encerrado.
goto :fim

:fim_com_erro
echo.
echo Nao foi possivel iniciar. Veja as mensagens acima.
echo.
pause
exit /b 1

:fim
endlocal
exit /b 0
