@echo off
rem Creates "Frame Aligner" shortcuts (desktop + this folder) that start the editor, with the app icon.
cd /d "%~dp0"
powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell; foreach($p in @([Environment]::GetFolderPath('Desktop'), (Get-Location).Path)){ $l=$s.CreateShortcut((Join-Path $p 'Frame Aligner.lnk')); $l.TargetPath=(Join-Path (Get-Location) 'start.bat'); $l.WorkingDirectory=(Get-Location).Path; $l.IconLocation=(Join-Path (Get-Location) 'static\icon.ico'); $l.WindowStyle=7; $l.Save() }"
echo Shortcut created on your desktop.
pause
