$ErrorActionPreference = 'Continue'
Set-Location -Path (Join-Path $PSScriptRoot '..')

Write-Host ''
Write-Host '  Steam Atlas / 蒸汽图鉴' -ForegroundColor Cyan
Write-Host '  正在启动本地服务...' -ForegroundColor DarkGray
Write-Host ''

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
  Write-Host '  [错误] 未找到 Node.js。' -ForegroundColor Red
  Write-Host '  请安装 Node.js 20+ 后重试： https://nodejs.org/' -ForegroundColor Red
  Write-Host '  或者把 node 所在目录加入系统 PATH。' -ForegroundColor Red
  Read-Host '  按回车键退出'
  exit 1
}

# 服务起来之后再打开浏览器
Start-Process powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"

Write-Host "  使用 Node: $node" -ForegroundColor DarkGray
Write-Host '  关闭本窗口即停止服务。' -ForegroundColor DarkGray
Write-Host ''

& $node server.mjs

if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  [错误] 服务启动失败。请检查端口 8787 是否被占用，或直接运行：node server.mjs' -ForegroundColor Red
  Read-Host '  按回车键退出'
}
