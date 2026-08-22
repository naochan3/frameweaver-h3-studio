Set objShell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\ogosh\work\frameweaver-h3-studio\scripts\Start-FrameWeaver.ps1"""
WScript.Quit objShell.Run(cmd, 0, True)
