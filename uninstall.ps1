param([switch] $PurgeState)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $root 'launcher/package-tools.ps1')
$manifest = Read-PackageManifest $root 'uninstall-manifest.json'
$failures = [Collections.Generic.List[string]]::new()
# An installed watcher owns its registrations. Restore only when it is active here.
$heartbeat = Resolve-PackageFile $root 'library/state/watch-heartbeat.json'
if (Test-Path -LiteralPath $heartbeat) {
    $state = Get-Content -LiteralPath $heartbeat -Raw | ConvertFrom-Json
    $expected = Resolve-PackageFile $root 'runtime/apply-theme.ts'
    $owner = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.ProcessId -eq $state.pid -and $_.CommandLine -and $_.CommandLine.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    if ($owner) {
        $env:CODEX_THEMES_HOME = Join-Path $root 'library'
        & (Join-Path $root 'tools/node/node.exe') --disable-warning=ExperimentalWarning --experimental-transform-types $expected restore
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore the active theme; no installation files were deleted.' }
    }
}
Stop-PackageWatcher $root
$shell = New-Object -ComObject WScript.Shell
$allowedShortcuts = @(
    (Join-Path $root 'G.E.M. Purple Codex.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'G.E.M. Purple Codex.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'G.E.M. Purple Codex.lnk')
)
foreach ($shortcut in @($manifest.shortcuts)) {
    if ($shortcut -in $allowedShortcuts -and (Test-Path -LiteralPath $shortcut)) {
        $link = $shell.CreateShortcut($shortcut)
        if ($link.TargetPath -eq (Join-Path $root 'GemPurpleCodex.exe')) {
            try { Remove-Item -LiteralPath $shortcut -Force } catch { $failures.Add($shortcut) }
        }
    }
}
$recoveryFiles = @('uninstall.ps1', 'Uninstall.cmd', 'launcher/package-tools.ps1')
foreach ($entry in @($manifest.files | Where-Object { $_.path -notin $recoveryFiles })) {
    $file = Resolve-PackageFile $root $entry.path
    try { if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force } } catch { $failures.Add($file) }
}
$icon = Resolve-PackageFile $root 'launcher/assets/codex.ico'
try { if (Test-Path -LiteralPath $icon) { Remove-Item -LiteralPath $icon -Force } } catch { $failures.Add($icon) }
$stateDirectory = Resolve-PackageFile $root 'library/state'
if ($PurgeState -and (Test-Path -LiteralPath $stateDirectory)) {
    # Validate every descendant before recursive deletion; do not follow links.
    Get-ChildItem -LiteralPath $stateDirectory -Recurse -Force | ForEach-Object { Assert-NoReparsePoint $_.FullName }
    try { Remove-Item -LiteralPath $stateDirectory -Recurse -Force } catch { $failures.Add($stateDirectory) }
}
if ($failures.Count) {
    $report = Join-Path $root 'cleanup-failures.txt'
    $failures | Set-Content -LiteralPath $report -Encoding UTF8
    throw "Some files could not be deleted. See $report"
}
foreach ($relative in $recoveryFiles) {
    $file = Resolve-PackageFile $root $relative
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
$oldReport = Resolve-PackageFile $root 'cleanup-failures.txt'
if (Test-Path -LiteralPath $oldReport) { Remove-Item -LiteralPath $oldReport -Force }
Remove-Item -LiteralPath (Join-Path $root 'uninstall-manifest.json') -Force
# Delete empty directories only. Preserve unknown files and logs unless requested.
$directories = @{}
foreach ($entry in $manifest.files) {
    $parent = Split-Path -Parent (Resolve-PackageFile $root $entry.path)
    while ($parent -and $parent -ne $root) { $directories[$parent] = $true; $parent = Split-Path -Parent $parent }
}
foreach ($directory in @($directories.Keys | Sort-Object Length -Descending)) {
    if ((Test-Path -LiteralPath $directory) -and -not @(Get-ChildItem -LiteralPath $directory -Force).Count) {
        Remove-Item -LiteralPath $directory -Force
    }
}
if (-not @(Get-ChildItem -LiteralPath $root -Force).Count) { Remove-Item -LiteralPath $root -Force }
Write-Output 'G.E.M. Purple Stage uninstalled. Codex and its user data were preserved.'
