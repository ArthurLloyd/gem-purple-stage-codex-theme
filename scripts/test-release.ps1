param([string] $ReleaseDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'packaging/release.json') -Raw | ConvertFrom-Json
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $root "dist/v$($config.version)" }
$work = Join-Path $root ('.tmp/test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$checks = 0
function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:checks++
    Write-Host "PASS: $Message"
}
function Run-Installer([string] $Source, [string] $Target, [int] $Expected = 0) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue' # Expected failures write to native stderr on PS 5.1.
        $output = & $powershell -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $Source 'install.ps1') -InstallDirectory $Target -NoShortcuts 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne $Expected) { throw "Install exit $code; expected $Expected.`n$output" }
    Assert ($code -eq $Expected) "install exit $Expected ($Target)"
}
try {
    $stem = "gem-purple-stage-$($config.version)-windows-$($config.architecture)"
    $zip = Join-Path $ReleaseDirectory "$stem-portable.zip"
    $setup = Join-Path $ReleaseDirectory "$stem-setup.exe"
    foreach ($line in Get-Content -LiteralPath (Join-Path $ReleaseDirectory 'SHA256SUMS.txt')) {
        $parts = $line -split '  ', 2
        Assert ((Get-FileHash -LiteralPath (Join-Path $ReleaseDirectory $parts[1]) -Algorithm SHA256).Hash -eq $parts[0]) "release checksum $($parts[1])"
    }
    $portable = Join-Path $work 'portable'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $portable)
    Assert (-not (Test-Path -LiteralPath (Join-Path $portable 'fig'))) 'raw photographs excluded'
    Assert (-not (Test-Path -LiteralPath (Join-Path $portable 'library/state'))) 'runtime state excluded'
    $node = Join-Path $portable 'tools/node/node.exe'
    $oldPath = $env:PATH
    try {
        $env:PATH = Join-Path $env:SystemRoot 'System32'
        $version = & $node --version
        Assert ($version -eq ('v' + $config.nodeVersion)) 'bundled Node.js works without system Node.js on PATH'
        & $node --disable-warning=ExperimentalWarning --experimental-transform-types (Join-Path $portable 'runtime/validate-theme.ts') (Join-Path $portable 'library/themes/gem-purple-stage-v3.1')
        Assert ($LASTEXITCODE -eq 0) 'packaged theme validates with bundled runtime'
    } finally { $env:PATH = $oldPath }
    $target = Join-Path $work '安装 测试 & sample'
    Run-Installer $portable $target
    Assert (Test-Path -LiteralPath (Join-Path $target 'GemPurpleCodex.exe')) 'native launcher installed in Chinese/space/shell-character path'
    $stateDir = Join-Path $target 'library/state'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $stateDir 'keep.log') -Value 'preserve'
    $unknown = Join-Path $target 'personal.txt'
    Set-Content -LiteralPath $unknown -Value 'user data'
    Run-Installer $portable $target
    Assert ((Get-Content -LiteralPath $unknown -Raw).Trim() -eq 'user data') 'upgrade preserves unknown user files'
    Assert (Test-Path -LiteralPath (Join-Path $stateDir 'keep.log')) 'upgrade preserves state'
    $foreign = Join-Path $work 'foreign'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    Set-Content -LiteralPath (Join-Path $foreign 'keep.txt') -Value 'do not overwrite'
    Run-Installer $portable $foreign 1
    Assert (-not (Test-Path -LiteralPath (Join-Path $foreign 'GemPurpleCodex.exe'))) 'foreign non-empty folder untouched'
    $tampered = Join-Path $portable 'CHANGELOG.md'
    $original = [IO.File]::ReadAllBytes($tampered)
    Add-Content -LiteralPath $tampered -Value 'tamper'
    $invalidTarget = Join-Path $work 'tampered-destination'
    Run-Installer $portable $invalidTarget 1
    Assert (-not (Test-Path -LiteralPath $invalidTarget)) 'tampered payload rejected before destination changes'
    [IO.File]::WriteAllBytes($tampered, $original)
    . (Join-Path $portable 'launcher/package-tools.ps1')
    foreach ($relative in @('../escape', 'C:\escape', 'tools/node.exe:stream', 'tools/../../escape')) {
        $rejected = $false
        try { $null = Resolve-PackageFile $target $relative } catch { $rejected = $true }
        Assert $rejected "unsafe package path rejected: $relative"
    }
    $junction = Join-Path $work 'junction'
    New-Item -ItemType Junction -Path $junction -Target $foreign | Out-Null
    Run-Installer $portable $junction 1
    # Exact link removal only, never recursively delete its target.
    (Get-Item -LiteralPath $junction -Force).Delete()
    $shortcutDesktop = Join-Path $work 'desktop'
    $shortcutPrograms = Join-Path $work 'programs'
    New-Item -ItemType Directory -Path $shortcutDesktop, $shortcutPrograms -Force | Out-Null
    & $powershell -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $target 'install-gem-purple-shortcut.ps1') -ProjectRoot $target -DesktopDirectory $shortcutDesktop -ProgramsDirectory $shortcutPrograms
    Assert ($LASTEXITCODE -eq 0) 'shortcut generation with client or launcher icon'
    if (-not ('GemPurpleShortcutShell' -as [type])) { Add-Type -Path (Join-Path $target 'launcher/shell-shortcut.cs') }
    foreach ($folder in @($target, $shortcutDesktop, $shortcutPrograms)) {
        $actualTarget = [GemPurpleShortcutShell]::ReadTarget((Join-Path $folder 'G.E.M. Purple Codex.lnk'))
        Assert ($actualTarget -eq (Join-Path $target 'GemPurpleCodex.exe')) "native shortcut target: $folder (actual: $actualTarget)"
    }
    Remove-Item -LiteralPath (Join-Path $target 'G.E.M. Purple Codex.lnk') -Force
    & $powershell -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $target 'uninstall.ps1')
    Assert ($LASTEXITCODE -eq 0) 'uninstall succeeds'
    Assert ((Test-Path -LiteralPath $unknown) -and (Test-Path -LiteralPath (Join-Path $stateDir 'keep.log'))) 'uninstall preserves unknown user files and logs'
    Assert (-not (Test-Path -LiteralPath (Join-Path $target 'tools/node/node.exe'))) 'uninstall removes bundled runtime'
    $setupTarget = Join-Path $work 'EXE 安装 trailing slash'
    $arguments = '/quiet /no-shortcuts /target:"' + $setupTarget + '\\"'
    $process = Start-Process -FilePath $setup -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    Assert ($process.ExitCode -eq 0) 'self-contained setup EXE installs with quoted trailing-backslash target'
    New-Item -ItemType Directory -Path (Join-Path $setupTarget 'library/state') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $setupTarget 'library/state/log.txt') -Value 'temporary state'
    $lockedPath = Join-Path $setupTarget 'CHANGELOG.md'
    $fileLock = [IO.File]::Open($lockedPath, 'Open', 'Read', 'None')
    try {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $null = & $powershell -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $setupTarget 'uninstall.ps1') 2>&1
            $failedExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousPreference }
        Assert ($failedExit -eq 1) 'locked file causes an explicit uninstall failure'
        $failureReport = Join-Path $setupTarget 'cleanup-failures.txt'
        Assert ((Get-Content -LiteralPath $failureReport -Raw).Contains($lockedPath)) 'cleanup report lists exact locked file'
        Assert (Test-Path -LiteralPath (Join-Path $setupTarget 'uninstall.ps1')) 'uninstall recovery entry retained after failure'
    } finally { $fileLock.Dispose() }
    & $powershell -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $setupTarget 'uninstall.ps1') -PurgeState
    Assert ($LASTEXITCODE -eq 0) 'purge-state uninstall succeeds'
    Assert (-not (Test-Path -LiteralPath $setupTarget)) 'purge-state uninstall removes empty installation folder'
    Write-Host "Release tests passed: $checks checks."
} finally {
    $resolved = [IO.Path]::GetFullPath($work)
    $prefix = [IO.Path]::GetFullPath((Join-Path $root '.tmp')) + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup path escapes .tmp.' }
    $leftoverLink = Join-Path $resolved 'junction'
    if (Test-Path -LiteralPath $leftoverLink) { (Get-Item -LiteralPath $leftoverLink -Force).Delete() }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
