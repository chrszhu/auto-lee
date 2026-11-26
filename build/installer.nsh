; Custom NSIS include for ZhuLoL.
;
; electron-builder's default "is the app running?" check (CHECK_APP_RUNNING) can
; hard-block the installer with "ZhuLoL cannot be closed. Please close it
; manually and click Retry" even when nothing is actually running, and the
; old-version removal step can fail if the app's files are still locked.
;
; allowOnlyOneInstallerInstance.nsh lets us override that check by defining the
; customCheckAppRunning macro (used by BOTH the installer and the uninstaller).
; We replace the blocking retry loop with a best-effort, non-interactive close
; that force-ends the whole app process tree (Electron spawns several child
; processes, all named the same) and waits for Windows to release the file
; handles, then continues. It never shows a blocking dialog, and it can't touch
; the installer process (whose exe name differs from the app's).

!macro customCheckAppRunning
  ; One cmd line (avoids duplicate NSIS labels when inserted into both the
  ; installer and uninstaller): force-kill the tree, wait, force-kill again, wait.
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & ping -n 3 127.0.0.1 >nul & taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & ping -n 2 127.0.0.1 >nul`
  Pop $0
!macroend
