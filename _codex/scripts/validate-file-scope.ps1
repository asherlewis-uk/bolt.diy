param(
  [string]$AllowedFilesList = ""
)
$ErrorActionPreference = "Stop"

if (-not $AllowedFilesList) {
  Write-Host "Usage: .\scripts\validate-file-scope.ps1 -AllowedFilesList scripts/allowed-files-current-pass.txt"
  exit 1
}

if (-not (Test-Path $AllowedFilesList)) {
  Write-Host "Allowed files list not found: $AllowedFilesList"
  exit 1
}

$allowed = Get-Content $AllowedFilesList |
  Where-Object { $_.Trim() -ne "" -and -not $_.Trim().StartsWith("#") } |
  ForEach-Object { $_.Trim().Replace('\','/') } |
  Sort-Object -Unique

# staged, unstaged, and untracked files
$porcelain = git status --porcelain=v1 2>$null
if (-not $porcelain) {
  Write-Host "validate-file-scope: PASS (no changed or untracked files)"
  exit 0
}

$changed = @()
foreach ($line in $porcelain) {
  if ($line.Length -lt 4) { continue }
  $path = $line.Substring(3).Trim()
  if ($path -match ' -> ') {
    $path = ($path -split ' -> ')[-1].Trim()
  }
  if ($path) {
    $changed += $path.Replace('\','/')
  }
}
$changed = $changed | Sort-Object -Unique

$failed = $false
foreach ($f in $changed) {
  if (-not ($allowed -contains $f)) {
    Write-Host "Out-of-scope file changed or created: $f"
    $failed = $true
  }
}

if ($failed) { exit 1 } else { Write-Host "validate-file-scope: PASS" }
