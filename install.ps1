# hydra-cli one-command installer (Windows PowerShell)
#   irm -Uri https://raw.githubusercontent.com/hydra-eng/hydra-cli/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dest = Join-Path (Get-Location) "hydra.mjs"
Write-Host ""
Write-Host "  hydra-cli installer" -ForegroundColor Magenta
Write-Host "  target: $dest"

try { $null = node --version } catch {
  Write-Host "  node >= 20 is required - install it from https://nodejs.org and re-run." -ForegroundColor Red
  exit 1
}

Invoke-WebRequest -Uri "https://raw.githubusercontent.com/hydra-eng/hydra-cli/main/hydra.mjs" -OutFile $dest -UseBasicParsing
Write-Host "  downloaded hydra.mjs" -ForegroundColor Green

node $dest --version
Write-Host ""
Write-Host "  start it anytime with:  node hydra.mjs" -ForegroundColor Cyan
Write-Host "  needs any OpenAI-compatible endpoint (ollama on localhost works out of the box)" -ForegroundColor DarkGray
Write-Host ""
