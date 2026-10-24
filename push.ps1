# push.ps1 — رفع تعديلات Windows إلى GitHub
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

git add -A
if (git diff --cached --quiet) {
    Write-Host "لا تغييرات للرفع" -ForegroundColor Yellow
    exit 0
}
git commit -m "windows: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
git push origin main
Write-Host "تم الرفع" -ForegroundColor Green