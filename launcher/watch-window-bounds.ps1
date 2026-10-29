param([Parameter(Mandatory = $true)][int] $OwnerPid)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'window-restore-guard.cs') -ReferencedAssemblies System.Windows.Forms
    [GemPurple.WindowRestoreGuard]::Run($OwnerPid)
} catch {
    # A compatibility helper failure must never stop theme injection.
    Write-Error "Window restore guard stopped: $($_.Exception.Message)"
    exit 1
}
