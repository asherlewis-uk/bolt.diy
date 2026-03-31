param(
  [switch]$StorageAuthorized = $false
)

$ErrorActionPreference = "Stop"

if ($StorageAuthorized) {
  Write-Host "validate-no-schema-leak: SKIPPED (storage authorized)"
  exit 0
}

function Normalize-Path {
  param([string]$Value)

  return $Value.Trim().Replace('\', '/')
}

function Get-PathList {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return @()
  }

  return @(
    Get-Content $Path |
      Where-Object { $_.Trim() -ne "" -and -not $_.Trim().StartsWith("#") } |
      ForEach-Object { Normalize-Path $_ } |
      Sort-Object -Unique
  )
}

function Get-ChangedPaths {
  $porcelain = git status --porcelain=v1 2>$null

  if (-not $porcelain) {
    return @()
  }

  $paths = @()

  foreach ($line in $porcelain) {
    if ($line.Length -lt 4) {
      continue
    }

    $path = $line.Substring(3).Trim()

    if ($path -match ' -> ') {
      $path = ($path -split ' -> ')[-1].Trim()
    }

    if ($path) {
      $paths += Normalize-Path $path
    }
  }

  return @($paths | Sort-Object -Unique)
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$baselinePath = Join-Path $scriptDir 'current-pass-baseline.txt'
$baseline = Get-PathList $baselinePath
$targets = @(
  Get-ChangedPaths |
    Where-Object { $baseline -notcontains $_ } |
    Where-Object { $_ -ne 'phase-report.md' } |
    Where-Object { $_ -notlike 'scripts/validate-*.ps1' } |
    Where-Object {
      $extension = [System.IO.Path]::GetExtension($_).ToLowerInvariant()
      $extension -ne '.md' -and $extension -ne '.txt'
    }
)

if (-not $targets -or $targets.Count -eq 0) {
  Write-Host "validate-no-schema-leak: PASS (no phase-local source files to inspect)"
  exit 0
}

$checks = @(
  @{ Name = 'create table'; Pattern = '\bcreate\s+table\b' },
  @{ Name = 'alter table'; Pattern = '\balter\s+table\b' },
  @{ Name = 'drop table'; Pattern = '\bdrop\s+table\b' },
  @{ Name = 'foreign key'; Pattern = '\bforeign\s+key\b' },
  @{ Name = 'primary key'; Pattern = '\bprimary\s+key\b' },
  @{ Name = 'table name'; Pattern = '\btable\s+name\b' },
  @{ Name = 'storage schema'; Pattern = '\bstorage\s+schema\b' },
  @{ Name = 'migration'; Pattern = '\bmigration(s)?\b' },
  @{ Name = 'prisma'; Pattern = '\bprisma\b' },
  @{ Name = 'typeorm'; Pattern = '\btypeorm\b' },
  @{ Name = 'drizzle'; Pattern = '\bdrizzle\b' },
  @{ Name = 'orchestrator_runs'; Pattern = '\borchestrator_runs\b' },
  @{ Name = 'project_memory'; Pattern = '\bproject_memory\b' },
  @{ Name = 'session_artifacts'; Pattern = '\bsession_artifacts\b' },
  @{ Name = 'run_history'; Pattern = '\brun_history\b' }
)

$failed = $false

foreach ($relativePath in $targets) {
  $absolutePath = Join-Path (Get-Location) $relativePath

  if (-not (Test-Path $absolutePath)) {
    continue
  }

  foreach ($check in $checks) {
    $matches = Select-String -Path $absolutePath -Pattern $check.Pattern -AllMatches -CaseSensitive:$false -ErrorAction SilentlyContinue

    foreach ($match in $matches) {
      Write-Host "Possible schema leak '$($check.Name)' found in ${relativePath}:$($match.LineNumber)"
      $failed = $true
    }
  }
}

if ($failed) {
  exit 1
}

Write-Host "validate-no-schema-leak: PASS"
