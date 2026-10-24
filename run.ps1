# Fahas launcher for Windows. Usage:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js and npm are required. Install them from https://nodejs.org first."
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

if (-not (Test-Path "node_modules/electron/dist/electron.exe")) {
    Write-Host "Fetching the Electron runtime..."
    node node_modules/electron/install.js
}

npm run dev
