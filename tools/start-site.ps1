$ErrorActionPreference = 'Continue'
# Node 输出是 UTF-8，这里统一按 UTF-8 解码再写日志，避免日志里出现乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [Text.Encoding]::UTF8
# 根目录优先从环境变量取（启动器会显式按 UTF-8 读取本文件，这样不依赖 BOM）
$root = if ($env:STEAM_ATLAS_HOME) { $env:STEAM_ATLAS_HOME.TrimEnd('\') } else { Split-Path $PSScriptRoot -Parent }
Set-Location -Path $root

$port = if ($env:PORT) { $env:PORT } else { '8787' }
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir "server-$port.log"
$startLog = Join-Path $logDir 'startup.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $startLog -Value $line -Encoding UTF8
}

Write-Log '--- 启动服务 ---'

# 已经在跑就别再起一份
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Log "端口 $port 已被占用，服务可能已经在运行，本次启动跳过。"
  exit 0
}

# 优先用 PATH 上的 node；找不到就用 DSH 自带的 Node 运行时
$node = $null
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) {
  $node = $onPath.Source
} else {
  $fallback = Join-Path $env:APPDATA 'dsh-desktop\harness\.desktop-bin\node.cmd'
  if (Test-Path $fallback) { $node = $fallback }
}

if (-not $node) {
  Write-Log '[错误] 未找到 Node.js。请安装 Node.js 20+ 或把 node 加入 PATH。'
  exit 1
}

Write-Log "使用 Node: $node"

# 服务起来之后再打开浏览器
Start-Process powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:$port'"

# 这个 PowerShell 会一直托管服务：窗口是隐藏的，但它会跟着服务一直活着。
# 停止服务请运行项目根目录的 停止服务.cmd（它按端口结束进程）。
Write-Log "服务已启动（端口 $port，窗口隐藏，日志见 logs\server-$port.log）。停止服务请运行 停止服务.cmd。"
& $node server.mjs 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8

# 有些 Node 运行时（例如 Electron 承载的 node.cmd）会脱离父进程直接返回，
# 这里改为按端口守着：只要服务还活着就保持窗口存活，服务停了才退出。
while ($true) {
  Start-Sleep -Seconds 5
  $up = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $up) { break }
}
Write-Log "服务已退出（端口 $port 不再监听）。"
