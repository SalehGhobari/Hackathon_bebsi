# sync.ps1 — سحب تعديلات GitHub (Linux) + بناء + فحص
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "=== git pull ===" -ForegroundColor Cyan
git pull origin main 2>&1 | Out-Host

Write-Host "=== build:main ===" -ForegroundColor Cyan
npm run build:main

Write-Host "=== test:scan ===" -ForegroundColor Cyan
npm run test:scan

Write-Host "=== done ===" -ForegroundColor Green