@echo off
set "GEM_PURPLE_UNINSTALL=%~dp0uninstall.ps1"
cd /d "%TEMP%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "%GEM_PURPLE_UNINSTALL%" %*
if errorlevel 1 (echo Uninstall failed. Check cleanup-failures.txt in the installation folder. & pause & exit /b 1)
echo Uninstall complete.
pause
