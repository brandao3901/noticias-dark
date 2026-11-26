@echo off
chcp 65001 >nul
title Canal Dark - render pelo terminal
cd /d "%~dp0"

rem Uso direto: render.bat <pautaId> [--formato fotos^|documento^|cartoes] [--voz blend]
if not "%~1"=="" (
  node scripts\render-cli.mjs render %*
  echo.
  pause
  exit /b %errorlevel%
)

:menu
cls
echo ==========================================
echo   CANAL DARK - gerar video pelo terminal
echo ==========================================
echo.
node scripts\render-cli.mjs list
echo.
set "PAUTA="
set /p "PAUTA=ID da pauta (Enter para sair): "
if "%PAUTA%"=="" exit /b 0

echo.
echo Formato: 1^) cartoes   2^) fotos   3^) documento
set "OPCAO="
set /p "OPCAO=Escolha [1]: "
if "%OPCAO%"=="" set "OPCAO=1"
if "%OPCAO%"=="1" set "FORMATO=cartoes"
if "%OPCAO%"=="2" set "FORMATO=fotos"
if "%OPCAO%"=="3" set "FORMATO=documento"
if not defined FORMATO set "FORMATO=cartoes"

echo.
node scripts\render-cli.mjs render %PAUTA% --formato %FORMATO% --voz blend --abrir

echo.
pause
goto menu
