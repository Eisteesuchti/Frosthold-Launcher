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
; Installiert zusätzlich das Microsoft VC++ 2015-2022 Redistributable (x64),
; das Skyrim Platform / MpClientPlugin beim Laden via SKSE brauchen. Ohne das
; crasht Skyrim vor dem Hauptmenü, obwohl Vanilla-Skyrim startet.

!macro customInstall
  SetShellVarContext current
  CreateDirectory "$APPDATA\frostholdrp-launcher"
  FileOpen $0 "$APPDATA\frostholdrp-launcher\prompt-desktop-shortcut" w
  FileWrite $0 "1"
  FileClose $0

  ; VC++ 2015-2022 Redistributable (x64). /install /quiet /norestart laeuft silent;
  ; Windows triggert UAC, wenn der per-user-Installer noch nicht elevated ist.
  ; Exit-Codes 0 = OK, 1638 = bereits neuere Version, 3010 = OK + Reboot empfohlen.
  IfFileExists "$INSTDIR\resources\bin\vc_redist.x64.exe" 0 SkipVCRedist
    DetailPrint "Installiere Microsoft Visual C++ 2015-2022 Redistributable..."
    ExecWait '"$INSTDIR\resources\bin\vc_redist.x64.exe" /install /quiet /norestart' $0
    DetailPrint "VC++ Redistributable Exit-Code: $0"
  SkipVCRedist:
!macroend
