<#
  Wren — one-step Windows installer (EYFS edition self-host bundle).
  Run by double-clicking "Install Wren (Windows).bat", or:
      powershell -ExecutionPolicy Bypass -File install-wren.ps1

  What it does:
    1. Checks Docker Desktop is installed and running (WSL2 backend).
    2. Creates .env from the template with strong random PG_PASSWORD + JWT_SECRET.
    3. Builds + starts Wren (app + bundled Postgres, demo data only).
    4. Opens http://localhost:<PORT> in your browser.
  No real children's data is included — the seed is fictional.
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# This script lives in docker/eyfs-selfhost/windows/ ; the compose file + .env.example
# are one level up in the bundle root — operate there.
Set-Location (Resolve-Path (Join-Path $here '..'))

function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "`n=== Wren self-host installer (Windows) ===`n" -ForegroundColor Cyan

# 1. Docker present + running?
if (-not (Have docker)) {
  Write-Host "Docker Desktop is not installed." -ForegroundColor Yellow
  Write-Host "Install it from https://www.docker.com/products/docker-desktop/ (keep the WSL2 engine option ticked), reboot if asked, then re-run this installer."
  Start-Process "https://www.docker.com/products/docker-desktop/"
  Read-Host "Press Enter to exit"; exit 1
}
try { docker info *> $null } catch {
  Write-Host "Docker is installed but not running. Start Docker Desktop, wait for it to say 'running', then re-run this installer." -ForegroundColor Yellow
  Read-Host "Press Enter to exit"; exit 1
}

# 2. .env — create with strong secrets if absent
function New-Hex([int]$bytes) {
  $b = New-Object 'System.Byte[]' $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  (Get-Content .env) `
    -replace '^PG_PASSWORD=.*', "PG_PASSWORD=$(New-Hex 24)" `
    -replace '^JWT_SECRET=.*',  "JWT_SECRET=$(New-Hex 32)" |
    Set-Content .env
  Write-Host "Created .env with freshly generated PG_PASSWORD and JWT_SECRET." -ForegroundColor Green
} else {
  Write-Host ".env already exists — leaving it as-is."
}

$port = ((Get-Content .env | Select-String '^PORT=') -replace 'PORT=', '').Trim()
if (-not $port) { $port = '8080' }

# 3. Build + start
Write-Host "`nBuilding and starting Wren (first run downloads images + builds — a few minutes)...`n"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose failed — see output above." -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }

# 4. Wait for health, open browser
Write-Host "`nWaiting for Wren to come up..."
$ok = $false
foreach ($i in 1..30) {
  Start-Sleep 3
  try { if ((Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 4).StatusCode -eq 200) { $ok = $true; break } } catch {}
}
if ($ok) {
  Write-Host "`nWren is up!  Opening http://localhost:$port" -ForegroundColor Green
  Write-Host "Demo manager login:  olivia@demo.wren   PIN 1234   (change it in Staff once you're in)`n"
  Start-Process "http://localhost:$port"
} else {
  Write-Host "`nWren didn't answer on http://localhost:$port yet. Check 'docker compose logs -f'." -ForegroundColor Yellow
}
Read-Host "Press Enter to close"
