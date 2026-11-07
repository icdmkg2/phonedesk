' Starts PhoneDesk with no console window (good for running at login).
' Put a shortcut to this file in shell:startup to start PhoneDesk with Windows.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c start.bat", 0, False
