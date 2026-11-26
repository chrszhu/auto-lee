@echo off
REM ---------------------------------------------------------------------------
REM  Optional cleanup of the OLD "LoL Companion" app (v0.1.0 - v0.4.2).
REM
REM  The app is now "ZhuLoL" with a new identity, so ZhuLoL installs cleanly
REM  without touching the old app. Run this only if you want to remove the old
REM  "LoL Companion" entry/files. Safe: it only touches that old app's own
REM  files + registry key.
REM
REM  Right-click this file -> "Run as administrator" (needed if it was installed
REM  for all users).
REM ---------------------------------------------------------------------------
setlocal
set "GUID=9fd553d6-f296-5af0-9c75-c9044e163771"

echo Closing LoL Companion if it is running...
taskkill /f /im "LoL Companion.exe" >nul 2>&1

for %%H in (HKCU HKLM) do (
  for /f "tokens=2,*" %%A in ('reg query "%%H\Software\Microsoft\Windows\CurrentVersion\Uninstall\%GUID%" /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do (
    echo Removing files: %%B
    rmdir /s /q "%%B" 2>nul
  )
  reg delete "%%H\Software\Microsoft\Windows\CurrentVersion\Uninstall\%GUID%" /f >nul 2>&1
)

REM Remove leftover Start Menu shortcuts
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\LoL Companion.lnk" >nul 2>&1
del /q "%ProgramData%\Microsoft\Windows\Start Menu\Programs\LoL Companion.lnk" >nul 2>&1

echo.
echo Done. The old "LoL Companion" app has been removed.
echo ZhuLoL (the new app) installs separately and is unaffected.
pause
