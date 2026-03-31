param(
  [string]$Path = ""
)
$ErrorActionPreference = "Stop"

if (-not $Path) {
  Write-Host "Usage: .\scripts\validate-pass-report.ps1 -Path phase-report.md"
  exit 1
}

if (-not (Test-Path $Path)) {
  Write-Host "Pass report not found: $Path"
  exit 1
}

$required = @(
  '## 1. Phase identity',
  '## 2. Repo exploration summary',
  '## 3. Allowlist',
  '## 4. Files changed',
  '## 5. Exact changes implemented',
  '## 6. Commands run',
  '## 7. Test evidence',
  '## 8. Validation evidence',
  '## 9. Scope control',
  '## 10. Placeholder control',
  '## 11. Risks and follow-up',
  '## 12. Proceed status',
  'Safe to proceed to next phase:'
)

$content = Get-Content $Path -Raw
$failed = $false

foreach ($r in $required) {
  if ($content -notmatch [regex]::Escape($r)) {
    Write-Host "Missing pass report section: $r"
    $failed = $true
  }
}

if ($content -match 'TODO|FIXME|HACK') {
  Write-Host "Pass report contains forbidden placeholder marker."
  $failed = $true
}

if ($failed) { exit 1 } else { Write-Host "validate-pass-report: PASS" }
