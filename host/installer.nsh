; Ajoute RemoteLink Host au démarrage Windows lors de l'installation
!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "RemoteLink Host" '"$INSTDIR\RemoteLink Host.exe" --autostart'
!macroend

; Supprime l'entrée au démarrage lors de la désinstallation
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RemoteLink Host"
!macroend
