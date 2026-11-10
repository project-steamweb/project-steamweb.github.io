@echo off
cd /d "%~dp0"
set "STEAM_ATLAS_HOME=%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$c=[IO.File]::ReadAllText($env:STEAM_ATLAS_HOME+'tools\start-site.ps1',[Text.Encoding]::UTF8); Invoke-Expression $c"
exit