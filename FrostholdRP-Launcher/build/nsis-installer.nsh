; Wird in den NSIS-Installationsablauf eingebunden (electron-builder).
;
; Installationsmodus fest auf „nur aktueller Benutzer“ (per-user, %LocalAppData%\Programs\…).
; Damit entfällt die NSIS-Seite „Für wen soll diese Anwendung installiert werden?“ — dort kann
; unter manchen Windows-Setups beim Klick auf „Weiter“ die UAC-/Elevate-Logik fehlschlagen und
; der Installer ohne Fehlermeldung beenden (electron-builder multiUserUi.nsh / UAC_RunElevated).
!macro customInstallMode
  StrCpy $isForceMachineInstall "0"
  StrCpy $isForceCurrentInstall "1"
!macroend

; Legt eine Markierungsdatei an, damit der Launcher einmalig nach Desktop-Verknüpfung fragt.

!macro customInstall
  SetShellVarContext current
  CreateDirectory "$APPDATA\frostholdrp-launcher"
  FileOpen $0 "$APPDATA\frostholdrp-launcher\prompt-desktop-shortcut" w
  FileWrite $0 "1"
  FileClose $0
!macroend
