@echo off
chcp 65001 >nul
title Canal Dark - console (Streamlit)
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem 1) Sobe o app (Node/Express) se ainda nao estiver rodando
rem ---------------------------------------------------------------------------
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  echo Subindo o app principal ^(Node^) em outra janela...
  start "Canal Dark - app" cmd /k "cd /d %~dp0 && npm run dev"
  echo Aguardando o app responder...
  for /l %%i in (1,1,40) do (
    timeout /t 2 >nul
    powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/config/status' -UseBasicParsing -TimeoutSec 2).StatusCode}catch{exit 1}" >nul 2>&1
    if not errorlevel 1 goto app_online
  )
  echo [aviso] O app demorou para subir. O console abre mesmo assim.
  goto app_ready
)
:app_online
echo App online em http://localhost:3000
:app_ready

rem ---------------------------------------------------------------------------
rem 2) Baixa os modelos do Kokoro na primeira execucao
rem ---------------------------------------------------------------------------
if not exist kokoro-v1.0.onnx (
  echo Baixando os modelos do Kokoro ^(~354 MB, so na primeira vez^)...
  python python\download_models.py
)

rem ---------------------------------------------------------------------------
rem 3) Abre o console
rem ---------------------------------------------------------------------------
echo.
echo ==========================================
echo   Console: http://localhost:8501
echo   App:     http://localhost:3000
echo   Hot-reload ativo (salvar arquivo recarrega)
echo ==========================================
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:8501'"

python -m streamlit run studio_app.py --server.port 8501 --server.address 127.0.0.1 --server.runOnSave true
pause
