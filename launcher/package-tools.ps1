# Shared by the offline installer and uninstaller; compatible with PowerShell 5.1.
$ErrorActionPreference = 'Stop'
function Assert-NoReparsePoint([string] $Path) {
    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked paths are not supported: $candidate" }
        }
        $parent = Split-Path -Parent $candidate
        if ($parent -eq $candidate) { break }
        $candidate = $parent
    }
}
function Resolve-PackageFile([string] $Root, [string] $RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath -match '(^|[\\/])\.\.([\\/]|$)|[:*?"<>|]') { throw "Invalid package path: $RelativePath" }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $resolved = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Package path escapes its folder: $RelativePath" }
    Assert-NoReparsePoint $resolved
    return $resolved
}
function Read-PackageManifest([string] $Root, [string] $Name = 'install-manifest.json') {
    $file = Resolve-PackageFile $Root $Name
    $manifest = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($manifest.productId -ne 'gem-purple-stage-codex-theme' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or
        @($manifest.files).Count -lt 10) { throw "Invalid installation manifest: $file" }
    $seen = @{}
    foreach ($entry in $manifest.files) {
        $null = Resolve-PackageFile $Root $entry.path
        if ($entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $seen.ContainsKey($entry.path)) { throw "Invalid manifest entry: $($entry.path)" }
        $seen[$entry.path] = $true
    }
    foreach ($required in @('GemPurpleCodex.exe', 'tools/node/node.exe', 'uninstall.ps1', 'launcher/package-tools.ps1')) {
        if (-not $seen.ContainsKey($required)) { throw "Manifest is missing $required" }
    }
    return $manifest
}
function Stop-PackageWatcher([string] $Root) {
    $watch = Resolve-PackageFile $Root 'library/state/watch.json'
    if (-not (Test-Path -LiteralPath $watch)) { return }
    $control = Get-Content -LiteralPath $watch -Raw | ConvertFrom-Json
    $control.enabled = $false
    $control | ConvertTo-Json | Set-Content -LiteralPath $watch -Encoding UTF8
    $expectedScript = Resolve-PackageFile $Root 'runtime/apply-theme.ts'
    $deadline = (Get-Date).AddSeconds(12)
    do {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($expectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if (-not $processes.Count) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'The installed theme is still running. Close its launcher and try again.'
}
