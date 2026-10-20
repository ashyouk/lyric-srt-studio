$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $taskRoot
if (!(Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    throw '先にREADMEの環境準備を実行してください。'
}
Get-Command ffmpeg, ffprobe, node -ErrorAction Stop | Out-Null
$env:PYTHONUTF8 = '1'
& .venv/Scripts/python.exe engine/server.py @args
