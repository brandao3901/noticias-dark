@echo off
chcp 65001 >nul
title Canal Dark - console (Streamlit)
cd /d "%~dp0"

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  echo Node offline. Abra outro terminal e rode: npm run dev
  echo O console precisa da API Node para renderizar.
  echo.
)

if not exist kokoro-v1.0.onnx (
  echo Baixando modelos do Kokoro pela primeira vez...
  python python\download_models.py
)

echo.
echo ==========================================
echo   Console: http://localhost:8501
echo   Hot-reload ativo (salvar arquivo recarrega)
echo ==========================================
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:8501'"

python -m streamlit run studio_app.py --server.port 8501 --server.address 127.0.0.1 --server.runOnSave true
pause
