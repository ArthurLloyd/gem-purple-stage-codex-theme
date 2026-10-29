$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $root 'launcher/window-restore-guard.cs') -ReferencedAssemblies System.Windows.Forms
function New-Geometry {
    param([int]$Width = 1240, [int]$Height = 840, [int]$Dpi = 96, [int]$Monitor = 1,
        [switch]$Maximized, [switch]$Minimized, [int]$WorkHeight = 1080)
    $geometry = New-Object GemPurple.WindowGeometry
    $geometry.Width = $Width; $geometry.Height = $Height; $geometry.Dpi = $Dpi
    $geometry.Monitor = [IntPtr]$Monitor
    $area = New-Object GemPurple.WindowRect
    $area.Right = 1920; $area.Bottom = $WorkHeight
    $geometry.WorkArea = $area
    $geometry.Maximized = [bool]$Maximized; $geometry.Minimized = [bool]$Minimized
    return $geometry
}
$baseline = New-Geometry
$cases = @(
    @{name='external display height doubles to stale minimum'; before=$baseline; after=(New-Geometry -Height 1200); expected=$true},
    @{name='both dimensions grow'; before=$baseline; after=(New-Geometry -Width 2480 -Height 1680); expected=$true},
    @{name='normal restore'; before=$baseline; after=(New-Geometry); expected=$false},
    @{name='frame rounding'; before=$baseline; after=(New-Geometry -Height 842); expected=$false},
    @{name='different DPI'; before=$baseline; after=(New-Geometry -Dpi 192 -Height 1680); expected=$false},
    @{name='different monitor'; before=$baseline; after=(New-Geometry -Monitor 2 -Height 1200); expected=$false},
    @{name='changed work area'; before=$baseline; after=(New-Geometry -Height 1200 -WorkHeight 1200); expected=$false},
    @{name='restore to maximized'; before=$baseline; after=(New-Geometry -Height 1080 -Maximized); expected=$false},
    @{name='minimize from maximized'; before=(New-Geometry -Maximized); after=(New-Geometry -Height 1200); expected=$false},
    @{name='still minimized'; before=$baseline; after=(New-Geometry -Height 1200 -Minimized); expected=$false},
    @{name='OS shrinks the window'; before=$baseline; after=(New-Geometry -Width 1000 -Height 700); expected=$false},
    @{name='invalid snapshot'; before=(New-Geometry -Dpi 0); after=(New-Geometry -Dpi 0 -Height 1200); expected=$false}
)
foreach ($case in $cases) {
    $actual = [GemPurple.RestoreBoundsPolicy]::ShouldRestore($case.before, $case.after)
    if ($actual -ne $case.expected) { throw "Window restore policy failed: $($case.name)" }
}
Write-Output "Window restore policy: $($cases.Count) cases passed."
