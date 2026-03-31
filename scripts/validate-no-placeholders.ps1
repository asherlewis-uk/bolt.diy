$ErrorActionPreference = "Stop"

function Normalize-Path {
  param([string]$Value)

  return $Value.Trim().Replace('\', '/')
}

function Get-RelativePathCompatible {
  param(
    [string]$BasePath,
    [string]$TargetPath
  )

  $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
  $targetFullPath = [System.IO.Path]::GetFullPath($TargetPath)

  if ($targetFullPath.StartsWith($baseFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relativePath = $targetFullPath.Substring($baseFullPath.Length).TrimStart('\', '/')
    return Normalize-Path $relativePath
  }

  $baseUri = New-Object System.Uri(($baseFullPath + [System.IO.Path]::DirectorySeparatorChar))
  $targetUri = New-Object System.Uri($targetFullPath)
  return Normalize-Path ([System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()))
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

function Get-BaselineSnapshot {
  param([string]$Path)

  $paths = Get-PathList $Path
  $hashes = @{}
  $mode = "legacy"

  foreach ($line in $paths) {
    if ($line.StartsWith("FILE`t")) {
      $parts = $line -split "`t"

      if ($parts.Length -ge 3) {
        $hashes[(Normalize-Path $parts[1])] = $parts[2]
        $mode = "structured"
      }
    }
  }

  return @{
    Mode = $mode
    Paths = $paths
    Hashes = $hashes
  }
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

function Get-FileFingerprint {
  param([string]$RelativePath)

  $absolutePath = Join-Path (Get-Location) $RelativePath

  if (-not (Test-Path -LiteralPath $absolutePath)) {
    return "__MISSING__"
  }

  $item = Get-Item -LiteralPath $absolutePath

  if ($item.PSIsContainer) {
    return "__DIRECTORY__"
  }

  return (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Expand-ChangedFiles {
  $paths = Get-ChangedPaths
  $expanded = @()

  foreach ($relativePath in $paths) {
    $absolutePath = Join-Path (Get-Location) $relativePath

    if ((Test-Path -LiteralPath $absolutePath) -and (Get-Item -LiteralPath $absolutePath).PSIsContainer) {
      $expanded += @(
        Get-ChildItem -LiteralPath $absolutePath -Recurse -File |
          ForEach-Object {
            Get-RelativePathCompatible -BasePath (Get-Location).Path -TargetPath $_.FullName
          }
      )
      continue
    }

    $expanded += $relativePath
  }

  return @($expanded | Sort-Object -Unique)
}

function Get-PhaseInspectionTargets {
  param(
    [string]$BaselinePath,
    [string]$AllowedFilesListPath = ""
  )

  $baseline = Get-BaselineSnapshot $BaselinePath
  $allowed = if ($AllowedFilesListPath) { Get-PathList $AllowedFilesListPath } else { @() }

  if ($baseline.Mode -eq "structured") {
    $phaseFiles = @()

    foreach ($relativePath in Expand-ChangedFiles) {
      $fingerprint = Get-FileFingerprint $relativePath
      $baselineFingerprint = $baseline.Hashes[$relativePath]

      if (-not $baseline.Hashes.ContainsKey($relativePath) -or $baselineFingerprint -ne $fingerprint) {
        $phaseFiles += $relativePath
      }
    }

    return @{
      Mode = "structured"
      Targets = @($phaseFiles | Sort-Object -Unique)
    }
  }

  $phasePaths = @(
    Get-ChangedPaths |
      Where-Object { $baseline.Paths -notcontains $_ } |
      Sort-Object -Unique
  )

  if ($phasePaths.Count -gt 0) {
    return @{
      Mode = "legacy-path-delta"
      Targets = $phasePaths
    }
  }

  return @{
    Mode = "legacy-allowlist-fallback"
    Targets = @($allowed | Sort-Object -Unique)
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$baselinePath = Join-Path $scriptDir 'current-pass-baseline.txt'
$allowedFilesList = Join-Path $scriptDir 'allowed-files-current-pass.txt'
$phaseTargets = Get-PhaseInspectionTargets -BaselinePath $baselinePath -AllowedFilesList $allowedFilesList
$targets = @(
  $phaseTargets.Targets |
    Where-Object { $_ -ne 'phase-report.md' } |
    Where-Object { $_ -notlike 'scripts/validate-*.ps1' }
)

if (-not $targets -or $targets.Count -eq 0) {
  Write-Host "validate-no-placeholders: PASS (no phase-local source files to inspect)"
  exit 0
}

$checks = @(
  @{ Name = 'TODO'; Pattern = '(?<![A-Za-z])TODO(?![A-Za-z])' },
  @{ Name = 'FIXME'; Pattern = '(?<![A-Za-z])FIXME(?![A-Za-z])' },
  @{ Name = 'HACK'; Pattern = '(?<![A-Za-z])HACK(?![A-Za-z])' },
  @{ Name = 'mock implementation'; Pattern = '\bmock implementation\b' },
  @{ Name = 'temporary fallback'; Pattern = '\btemporary fallback\b' },
  @{ Name = 'stubbed'; Pattern = '\bstubbed\b' },
  @{ Name = 'placeholder logic'; Pattern = '\bplaceholder logic\b' },
  @{ Name = 'placeholder implementation'; Pattern = '\bplaceholder implementation\b' },
  @{ Name = 'placeholder scaffolding'; Pattern = '\bplaceholder scaffolding\b' },
  @{ Name = 'fake adapter'; Pattern = '\bfake adapter\b' },
  @{ Name = 'fake repository'; Pattern = '\bfake repository\b' },
  @{ Name = 'fake memory'; Pattern = '\bfake memory\b' },
  @{ Name = 'fake persistence'; Pattern = '\bfake persistence\b' }
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
      Write-Host "Forbidden placeholder marker '$($check.Name)' found in ${relativePath}:$($match.LineNumber)"
      $failed = $true
    }
  }
}

if ($failed) {
  exit 1
}

if ($phaseTargets.Mode -eq 'legacy-allowlist-fallback') {
  Write-Host "validate-no-placeholders: PASS (legacy path-only baseline fallback; inspected declared phase scope)"
  exit 0
}

Write-Host "validate-no-placeholders: PASS"
