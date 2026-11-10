@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Steam Atlas / 蒸汽图鉴
echo   正在启动本地服务...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未找到 Node.js。
  echo   请安装 Node.js 20+ 后重试： https://nodejs.org/
  pause
  exit /b 1
)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"
node server.mjs
if errorlevel 1 (
  echo.
  echo   [错误] 服务启动失败。请检查端口 8787 是否被占用，或直接运行：node server.mjs
  pause
  exit /b 1
)
echo.
echo   服务已退出。按任意键关闭窗口。
pause >nul
