' Portable one-click entry. WScript starts PowerShell without a console window.
Option Explicit
Dim shell, files, projectRoot, launcher, powerShell, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
projectRoot = files.GetParentFolderName(WScript.ScriptFullName)
launcher = files.BuildPath(files.BuildPath(projectRoot, "launcher"), "start-gem-purple-codex.ps1")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
shell.CurrentDirectory = projectRoot
command = Chr(34) & powerShell & Chr(34) & " -NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File " & Chr(34) & launcher & Chr(34) & " -AllowForceRestart"
shell.Run command, 0, False
