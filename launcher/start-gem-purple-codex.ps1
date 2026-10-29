# Hidden Windows PowerShell entry invoked by the native launcher or legacy VBS.
param([switch] $AllowForceRestart)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$themeDir = Join-Path $projectRoot 'library\themes\gem-purple-stage-v3.1'
$applyScript = Join-Path $projectRoot 'runtime\apply-theme.ts'
$activationScript = Join-Path $projectRoot 'launcher\activate-codex.ps1'
$stateDir = Join-Path $projectRoot 'library\state'
$logPath = Join-Path $stateDir 'launcher.log'
$port = 9335
$lock = $null

function Write-LaunchLog([string] $message) {
    "$(Get-Date -Format o) $message" | Add-Content -LiteralPath $logPath
}

function Find-CodexExe {
    # Never persist a versioned WindowsApps directory.
    $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending)
    foreach ($package in $packages) {
        $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    # Restricted sessions may hide the Appx package database.
    foreach ($process in @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)) {
        try {
            if ($process.Path -and (Test-Path -LiteralPath $process.Path -PathType Leaf) -and
                $process.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$') {
                return $process.Path
            }
        } catch { }
    }
    throw 'Cannot find Codex ChatGPT.exe through Get-AppxPackage or a running Codex process.'
}

function Find-CodexAumid {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
        Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'Cannot find the installed OpenAI.Codex package for MSIX activation.' }
    $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
    $application = $manifest.Package.Applications.Application |
        Where-Object { $_.Executable -eq 'app/ChatGPT.exe' } | Select-Object -First 1
    if (-not $application -or -not $package.PackageFamilyName) {
        throw "Cannot find the Codex application ID in $manifestPath"
    }
    return "$($package.PackageFamilyName)!$($application.Id)"
}

function Get-AppTargets {
    foreach ($loopbackHost in @('127.0.0.1', '[::1]')) {
        try {
            # PS 5.1 emits a JSON array as one pipeline object; assign it directly
            # before filtering so each target is inspected, not the array itself.
            $targets = Invoke-RestMethod -Uri "http://${loopbackHost}:$port/json/list" -TimeoutSec 1
            $pages = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^app://-(?:/|$)' -and
                $_.url -notmatch '[?&]initialRoute=(?:%2F|/)avatar-overlay(?:&|$)' })
            if ($pages.Count -gt 0) { return $pages }
        } catch { }
    }
    return @()
}

function Wait-AppTargets([int] $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    do {
        $targets = @(Get-AppTargets)
        if ($targets.Count -gt 0) { return $targets }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return @()
}

function Get-MainCodexProcess {
    # Exclude renderer, GPU, utility and crashpad children. The primary process
    # owns the single-instance profile lock and is the only one to close.
    return @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
}

function Wait-CodexExit([int] $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    $clearSince = $null
    do {
        if (@(Get-MainCodexProcess).Count -eq 0) {
            if ($null -eq $clearSince) { $clearSince = Get-Date }
            if (((Get-Date) - $clearSince).TotalSeconds -ge 2) { return $true }
        } else { $clearSince = $null }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

try {
    # Windows PowerShell 5.1 otherwise decodes Node's UTF-8 JSON using the
    # console code page. A Chinese page title then makes ConvertFrom-Json fail.
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stateDir 'tmp') -Force | Out-Null
    try {
        $lock = [System.IO.File]::Open((Join-Path $stateDir 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [System.IO.IOException] {
        exit 0 # Another double-click is already starting this theme.
    }
    if (-not (Test-Path -LiteralPath (Join-Path $themeDir 'theme.json') -PathType Leaf)) { throw "Theme missing: $themeDir" }
    if (-not (Test-Path -LiteralPath $applyScript -PathType Leaf)) { throw "Theme injector missing: $applyScript" }
    if (-not (Test-Path -LiteralPath $activationScript -PathType Leaf)) { throw "MSIX activator missing: $activationScript" }
    $node = Join-Path $projectRoot 'tools\node\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
    $appPath = Find-CodexExe
    $appUserModelId = Find-CodexAumid
    $env:CODEX_THEMES_HOME = Join-Path $projectRoot 'library'
    $env:TEMP = Join-Path $stateDir 'tmp'
    $env:TMP = $env:TEMP
    Write-LaunchLog "Starting v3.1 with $appPath"

    if (@(Get-AppTargets).Count -eq 0) {
        $running = @(Get-MainCodexProcess)
        if ($running.Count -gt 0) {
            Write-LaunchLog 'Closing Codex for a fresh launch with debugging enabled.'
            foreach ($process in $running) {
                $pidToClose = [int]$process.ProcessId
                $quit = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', [string]$pidToClose) -Wait -PassThru -WindowStyle Hidden
                Write-LaunchLog "Requested Codex main process $pidToClose exit (taskkill code $($quit.ExitCode))."
            }
            if (-not (Wait-CodexExit 12)) {
                if (-not $AllowForceRestart) {
                    throw 'Codex is still running in the background. Exit Codex fully before trying again; forced restart has not been authorized.'
                }
                # Closing the window can leave Codex resident in the tray. End only
                # the identified main process tree so launch flags can take effect.
                foreach ($process in @(Get-MainCodexProcess)) {
                    $pidToClose = [int]$process.ProcessId
                    $forced = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/F', '/T', '/PID', [string]$pidToClose) -Wait -PassThru -WindowStyle Hidden
                    Write-LaunchLog "Ended resident Codex main process $pidToClose (taskkill code $($forced.ExitCode))."
                }
                if (-not (Wait-CodexExit 20)) {
                    throw 'Codex did not exit. Close it from the tray and double-click G.E.M. Purple Codex again.'
                }
            }
        }
        $arguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$port")
        $activatedPid = & $activationScript -AppUserModelId $appUserModelId -ArgumentLine ($arguments -join ' ')
        Write-LaunchLog "Activated $appUserModelId as process $activatedPid with CDP port $port"
        if (@(Wait-AppTargets 45).Count -eq 0) {
            throw "Codex opened without an app CDP target on loopback port $port (127.0.0.1 or ::1). See the launch log for diagnosis."
        }
    }

    $nodeArgs = @('--disable-warning=ExperimentalWarning', '--experimental-transform-types', $applyScript)
    $output = & $node @nodeArgs apply $themeDir --port $port 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Theme apply failed: $($output | Out-String)" }
    $deadline = (Get-Date).AddSeconds(45)
    $lastStatus = 'No status response yet.'
    do {
        $statusOutput = & $node @nodeArgs status --port $port 2>&1
        if ($LASTEXITCODE -eq 0) {
            try {
                $status = ($statusOutput | Out-String | ConvertFrom-Json)
                $lastStatus = "theme=$($status.status), watcher=$($status.watcher.status), pages=$(@($status.pages).Count)"
                if ($status.status -eq 'active' -and $status.themeId -eq 'gem-purple-stage-v3-1' -and
                    $status.watcher.status -eq 'active') {
                    Write-LaunchLog "v3.1 active on $(@($status.pages).Count) targets; watcher PID $($status.watcher.pid)"
                    exit 0
                }
            } catch {
                $lastStatus = 'Could not parse theme status JSON.'
                Write-LaunchLog "Status parse error: $($_.Exception.Message.Split([Environment]::NewLine)[0])"
            }
        } else {
            $lastStatus = "Theme status command exited $LASTEXITCODE."
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "The theme or watcher did not become active within 45 seconds. Last check: $lastStatus. See $logPath."
} catch {
    $message = $_.Exception.Message
    try { Write-LaunchLog "ERROR $message" } catch { }
    try {
        $dialog = New-Object -ComObject WScript.Shell
        [void]$dialog.Popup("G.E.M. Purple Codex could not start.`n`n$message`n`nLog: $logPath", 0, 'G.E.M. Purple Codex', 16)
    } catch { }
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
}
