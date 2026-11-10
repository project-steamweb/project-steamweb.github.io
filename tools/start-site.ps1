$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -Path $root

$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'server.log'
$startLog = Join-Path $logDir 'startup.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $startLog -Value $line -Encoding UTF8
}

Write-Log '--- 启动服务 ---'

# 已经在跑就别再起一份
$busy = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Log '端口 8787 已被占用，服务可能已经在运行，本次启动跳过。'
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
Start-Process powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8787'"

# 服务在后台跑，日志写到 logs\server.log，窗口不显示
Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $logDir 'server.err.log')
Write-Log '服务已在后台启动，窗口已隐藏。'
