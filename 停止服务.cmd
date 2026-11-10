@echo off
cd /d "%~dp0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
echo Steam Atlas stopped.
exit