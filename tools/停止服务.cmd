@echo off
chcp 65001 >nul
echo.
echo   正在停止 Steam Atlas 服务...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>&1
)
echo   已停止。
pause
