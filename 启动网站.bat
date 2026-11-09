@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Steam Atlas / 蒸汽图鉴
echo   正在启动本地服务...
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"
node server.mjs
echo.
echo   服务已退出。按任意键关闭窗口。
pause >nul
