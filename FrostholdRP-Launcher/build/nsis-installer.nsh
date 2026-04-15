; Wird in den NSIS-Installationsablauf eingebunden (electron-builder).
; Legt eine Markierungsdatei an, damit der Launcher einmalig nach Desktop-Verknüpfung fragt.

!macro customInstall
  SetShellVarContext current
  CreateDirectory "$APPDATA\frostholdrp-launcher"
  FileOpen $0 "$APPDATA\frostholdrp-launcher\prompt-desktop-shortcut" w
  FileWrite $0 "1"
  FileClose $0
!macroend
