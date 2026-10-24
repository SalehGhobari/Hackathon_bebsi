# auto-sync.ps1 — سحب تلقائي (كل 60s) + بناء عند التغيير
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "Auto-sync started. Press Ctrl+C to stop." -ForegroundColor Cyan
while ($true) {
    $before = git rev-parse HEAD 2>$null
    git pull origin main 2>&1 | Out-Null
    $after = git rev-parse HEAD 2>$null
    if ($before -ne $after) {
        Write-Host "New changes pulled. Rebuilding..." -ForegroundColor Green
        npm run build:main
        Write-Host "Rebuild done. Restart 'npm run dev' to see changes." -ForegroundColor Yellow
    }
    Start-Sleep 60
}