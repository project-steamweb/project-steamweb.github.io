@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo.
echo   Steam Atlas / 蒸汽图鉴 —— 后台服务
echo   日志写入 logs\server.log
echo.
if not exist "logs" mkdir logs
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未找到 Node.js 20+。请先安装： https://nodejs.org/
  pause
  exit /b 1
)
start "Steam Atlas" /min cmd /c "node server.mjs >> logs\server.log 2>&1"
echo   已在后台启动。停止服务： 运行 tools\停止服务.cmd
echo.
timeout /t 3 >nul
curl -s -o NUL -w "   本地自检 http://127.0.0.1:8787 -> HTTP %%{http_code}\n" --max-time 8 http://127.0.0.1:8787/api/config
pause
