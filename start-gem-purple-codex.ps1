# Compatibility entry for older links. The maintained launcher lives in launcher/.
$launcher = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'launcher\start-gem-purple-codex.ps1'
& $launcher
exit $LASTEXITCODE
