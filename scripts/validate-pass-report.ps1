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

if ($content -notmatch 'PHASE\s+\d+\s+IMPLEMENTATION REPORT') {
  Write-Host "Missing pass report title in the form: PHASE X IMPLEMENTATION REPORT"
  $failed = $true
}

foreach ($requiredItem in $required) {
  if ($content -notmatch [regex]::Escape($requiredItem)) {
    Write-Host "Missing pass report section: $requiredItem"
    $failed = $true
  }
}

Get-Content $Path | ForEach-Object {
  $line = $_

  if ($line -match 'TODO|FIXME|HACK') {
    $isAllowedEvidenceLine =
      $line -match 'no TODO/FIXME/HACK markers remain' -or
      $line -match 'rg -n "TODO\|FIXME\|HACK'

    if (-not $isAllowedEvidenceLine) {
      Write-Host "Pass report contains forbidden placeholder marker."
      $failed = $true
    }
  }
}

if ($failed) {
  exit 1
}

Write-Host "validate-pass-report: PASS"
