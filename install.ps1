param(
    [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'GemPurpleCodex'),
    [switch] $NoShortcuts
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $source 'launcher/package-tools.ps1')
$target = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\', '/')
Assert-NoReparsePoint $target
if ($target -eq $source -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Install outside the extracted package folder.' }
$manifest = Read-PackageManifest $source
if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
# Verify the entire payload before changing an existing installation.
foreach ($entry in $manifest.files) {
    $file = Resolve-PackageFile $source $entry.path
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Package checksum mismatch: $($entry.path)" }
    $null = Resolve-PackageFile $target $entry.path
}
$previous = $null
if (Test-Path -LiteralPath $target) {
    if (Test-Path -LiteralPath (Join-Path $target 'uninstall-manifest.json')) {
        $previous = Read-PackageManifest $target 'uninstall-manifest.json'
    } elseif (@(Get-ChildItem -LiteralPath $target -Force).Count) {
        throw "Choose an empty folder or an existing G.E.M. Purple installation: $target"
    }
}
$node = Resolve-PackageFile $source 'tools/node/node.exe'
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne ('v' + $manifest.nodeVersion)) { throw 'The bundled Node.js runtime is incompatible.' }
if ($previous) { Stop-PackageWatcher $target }
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($entry in $manifest.files) {
    $destination = Resolve-PackageFile $target $entry.path
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Resolve-PackageFile $source $entry.path) -Destination $destination -Force
}
$shortcuts = @()
if ($previous -and $previous.shortcuts) { $shortcuts = @($previous.shortcuts) }
if (-not $NoShortcuts) {
    & (Join-Path $target 'install-gem-purple-shortcut.ps1') -ProjectRoot $target
    $shortcuts = @(
        (Join-Path $target 'G.E.M. Purple Codex.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'G.E.M. Purple Codex.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'G.E.M. Purple Codex.lnk')
    )
}
$manifest | Add-Member -NotePropertyName shortcuts -NotePropertyValue $shortcuts -Force
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $target 'uninstall-manifest.json') -Encoding UTF8
if ($previous) {
    foreach ($entry in $previous.files) {
        if ($entry.path -notin @($manifest.files.path)) {
            $obsolete = Resolve-PackageFile $target $entry.path
            if (Test-Path -LiteralPath $obsolete -PathType Leaf) { Remove-Item -LiteralPath $obsolete -Force }
        }
    }
}
Write-Output "Installed G.E.M. Purple Stage $($manifest.version): $target"
