param(
  [string]$ApprovedStorageRecord = ""
)
$ErrorActionPreference = "Stop"

if (-not $ApprovedStorageRecord) {
  Write-Host "Usage: .\scripts\validate-schema-drift.ps1 -ApprovedStorageRecord docs/04_STORAGE_DECISION_RECORD.md"
  exit 1
}

if (-not (Test-Path $ApprovedStorageRecord)) {
  Write-Host "Approved storage record not found: $ApprovedStorageRecord"
  exit 1
}

$record = Get-Content $ApprovedStorageRecord -Raw
$recordLower = $record.ToLowerInvariant()

$schemaPatterns = @(
  'create table',
  'alter table',
  'drop table',
  'primary key',
  'foreign key',
  'index ',
  'unique ',
  'migration',
  'migrations'
)

$exclude = @('.git','node_modules','dist','build','.next','.vercel','.wrangler','scripts/validate-schema-drift.ps1','docs/04_STORAGE_DECISION_RECORD.md')
$failed = $false

Get-ChildItem -Recurse -File | Where-Object {
    $full = $_.FullName.Replace('\','/')
    -not ($exclude | ForEach-Object { $full -like "*$_*" } | Where-Object { $_ })
} | ForEach-Object {
    $path = $_.FullName
    $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return }
    $contentLower = $content.ToLowerInvariant()

    foreach ($p in $schemaPatterns) {
        if ($contentLower -match [regex]::Escape($p) -and $recordLower -notmatch [regex]::Escape($p)) {
            Write-Host "Schema drift pattern '$p' found outside approved storage record in $path"
            $failed = $true
        }
    }
}

if ($failed) { exit 1 } else { Write-Host "validate-schema-drift: PASS" }
