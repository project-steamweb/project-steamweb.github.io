@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Cloudflare 隧道（把本机 127.0.0.1:8787 暴露到 steam.wangzic.fun）
echo.
if not exist "tools\.tunnel-token.txt" (
  echo   [错误] 还没有配置隧道令牌。
  echo.
  echo   配置方法：
  echo     1. 打开 https://one.dash.cloudflare.com/ 左侧 Networks ^> Tunnels
  echo     2. Create a tunnel ^> 选 Cloudflared ^> 命名 steam-atlas
  echo     3. 在 Configure page 复制那行 "cloudflared tunnel run --token ..." 里的令牌
  echo     4. 把令牌填进本目录的 tools\.tunnel-token.txt 文件（只有令牌本身）
  echo.
  pause
  exit /b 1
)
set /p TOKEN=<tools\.tunnel-token.txt
if "%TOKEN%"=="" (
  echo   [错误] tools\.tunnel-token.txt 是空的。
  pause
  exit /b 1
)
echo   正在连接 Cloudflare...
echo.
tools\cloudflared.exe tunnel run --token %TOKEN%
echo.
echo   隧道已退出。按任意键关闭窗口。
pause >nul
