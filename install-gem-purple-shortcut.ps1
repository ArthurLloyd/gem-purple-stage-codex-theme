# Creates project, desktop and Start Menu shortcuts without changing the official shortcut.
param(
    [string] $ProjectRoot = $PSScriptRoot,
    [string] $DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
    [string] $ProgramsDirectory = [Environment]::GetFolderPath('Programs')
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$launcher = Join-Path $projectRoot 'GemPurpleCodex.exe'
$nativeLauncher = Test-Path -LiteralPath $launcher -PathType Leaf
if (-not $nativeLauncher) { $launcher = Join-Path $projectRoot 'G.E.M. Purple Codex.vbs' }
if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher missing: $launcher" }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$desktop = $DesktopDirectory
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) {
    throw 'Desktop folder is unavailable; no shortcut was changed.'
}
New-Item -ItemType Directory -Path $ProgramsDirectory -Force | Out-Null

# Cache the installed app's icon outside runtime state. A WindowsApps version
# directory disappears after an app update; it must never be a shortcut icon.
Add-Type -AssemblyName System.Drawing
function Test-ShortcutIcon([string] $path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $check = $null
    try {
        $check = [Drawing.Icon]::new($path)
        return $check.Width -gt 0 -and $check.Height -gt 0
    } catch { return $false }
    finally { if ($check) { $check.Dispose() } }
}
$icon = Join-Path $projectRoot 'launcher\assets\codex.ico'
if (-not (Test-ShortcutIcon $icon)) {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending | Select-Object -First 1
    $executable = if ($package) { Join-Path $package.InstallLocation 'app\ChatGPT.exe' } else { $null }
    if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        $running = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' } |
            Select-Object -First 1
        $executable = if ($running) { $running.Path } else { $null }
    }
    if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        if ($nativeLauncher) { $executable = $launcher }
        else { throw 'Cannot find the installed Codex icon; no shortcut was changed.' }
    }
    $resourceIcon = Join-Path (Split-Path -Parent $executable) 'resources\icon-chatgpt.ico'
    New-Item -ItemType Directory -Path (Split-Path -Parent $icon) -Force | Out-Null
    if (Test-ShortcutIcon $resourceIcon) {
        Copy-Item -LiteralPath $resourceIcon -Destination $icon -Force
    } else {
        $extracted = [Drawing.Icon]::ExtractAssociatedIcon($executable)
        if (-not $extracted) { throw 'Cannot extract the installed Codex icon; no shortcut was changed.' }
        try {
            $stream = [IO.File]::Open($icon, 'Create', 'Write', 'None')
            try { $extracted.Save($stream) } finally { $stream.Dispose() }
        } finally { $extracted.Dispose() }
    }
    if (-not (Test-ShortcutIcon $icon)) { throw 'The local Codex icon is invalid; no shortcut was changed.' }
}

# Tell Explorer which two items changed; no icon-cache purge or restart needed.
# https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify
if (-not ('GemPurpleShortcutShell' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'launcher/shell-shortcut.cs')
}
foreach ($shortcutPath in @((Join-Path $projectRoot 'G.E.M. Purple Codex.lnk'), (Join-Path $desktop 'G.E.M. Purple Codex.lnk'), (Join-Path $ProgramsDirectory 'G.E.M. Purple Codex.lnk'))) {
    $existed = Test-Path -LiteralPath $shortcutPath -PathType Leaf
    $targetPath = if ($nativeLauncher) { $launcher } else { $wscript }
    $arguments = if ($nativeLauncher) { '' } else { '"' + $launcher + '"' }
    [GemPurpleShortcutShell]::Save($shortcutPath, $targetPath, $arguments, $projectRoot, $icon)
    # SHCNE_UPDATEITEM / SHCNE_CREATE, with SHCNF_PATHW.
    $eventId = if ($existed) { 0x2000 } else { 0x0002 }
    [GemPurpleShortcutShell]::SHChangeNotify($eventId, 0x0005, $shortcutPath, [IntPtr]::Zero)
    Write-Host "Shortcut created: $shortcutPath"
}
