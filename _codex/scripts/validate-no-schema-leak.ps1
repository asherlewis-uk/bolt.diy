param(
  [switch]$StorageAuthorized = $false
)
$ErrorActionPreference = "Stop"

if ($StorageAuthorized) {
  Write-Host "validate-no-schema-leak: SKIPPED (storage authorized)"
  exit 0
}

$patterns = @(
  'create table',
  'alter table',
  'drop table',
  'foreign key',
  'primary key',
  'column',
  'columns',
  'table name',
  'orchestrator_runs',
  'project_memory',
  'session_artifacts',
  'run_history',
  'storage schema',
  'migration',
  'migrations',
  'prisma',
  'typeorm',
  'drizzle'
)

$exclude = @('.git','node_modules','dist','build','.next','.vercel','.wrangler','docs/04_STORAGE_DECISION_RECORD.md','docs/03_STORAGE_GATE.md','scripts/validate-no-schema-leak.ps1')
$failed = $false

Get-ChildItem -Recurse -File | Where-Object {
    $full = $_.FullName.Replace('\','/')
    -not ($exclude | ForEach-Object { $full -like "*$_*" } | Where-Object { $_ })
} | ForEach-Object {
    $path = $_.FullName
    $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return }
    $contentLower = $content.ToLowerInvariant()

    foreach ($p in $patterns) {
        if ($contentLower -match [regex]::Escape($p)) {
            Write-Host "Possible schema leak '$p' found in $path"
            $failed = $true
        }
    }
}

if ($failed) { exit 1 } else { Write-Host "validate-no-schema-leak: PASS" }
