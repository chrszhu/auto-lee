@echo off
REM ---------------------------------------------------------------------------
REM  LoL Companion - one-time cleanup of an old install (v0.1.0)
REM
REM  Removes a previous LoL Companion install that has the buggy NSIS
REM  "cannot be closed" check, so the new installer won't try to run its broken
REM  uninstaller. Safe: it only touches LoL Companion's own files + registry key.
REM
REM  Right-click this file -> "Run as administrator" (needed if it was installed
REM  for all users), then run LoLCompanion-Setup-0.4.1.exe (or newer).
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
echo Done. Old LoL Companion removed.
echo Now run LoLCompanion-Setup-0.4.1.exe to install fresh.
pause
