@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0install.ps1"
if errorlevel 1 (echo Installation failed. & pause & exit /b 1)
echo Installation complete. Use the G.E.M. Purple Codex shortcut.
pause
