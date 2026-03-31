$ErrorActionPreference = "Stop"
$patterns = @('TODO','FIXME','HACK','placeholder','stubbed','mock implementation','temporary fallback')
$exclude = @('.git','node_modules','dist','build','.next','.vercel','.wrangler')
$failed = $false

Get-ChildItem -Recurse -File | Where-Object {
    $full = $_.FullName
    -not ($exclude | ForEach-Object { $full -match [regex]::Escape($_) } | Where-Object { $_ })
} | ForEach-Object {
    $path = $_.FullName
    $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
    foreach ($p in $patterns) {
        if ($content -match [regex]::Escape($p)) {
            Write-Host "Forbidden placeholder pattern '$p' found in $path"
            $failed = $true
        }
    }
}

if ($failed) { exit 1 } else { Write-Host "validate-no-placeholders: PASS" }
