; Custom NSIS include for LoL Companion.
;
; electron-builder's default "is the app running?" check (CHECK_APP_RUNNING)
; can false-positive on upgrade and hard-block the installer with
; "LoL Companion cannot be closed. Please close it manually and click Retry",
; even when nothing is actually running.
;
; allowOnlyOneInstallerInstance.nsh lets us override that check by defining the
; customCheckAppRunning macro. We replace the blocking retry loop with a
; best-effort, non-interactive close: try to end any running instance for the
; current user, then just continue. It never shows a blocking dialog, and it
; can't touch the installer process (whose exe name differs from the app's).

!macro customCheckAppRunning
  ; graceful close first
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
  Pop $0
  Sleep 400
  ; then force, in case it didn't exit
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
  Pop $0
  Sleep 300
!macroend
