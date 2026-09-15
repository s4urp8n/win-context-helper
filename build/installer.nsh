; electron-builder NSIS hooks. The app registers its own Explorer menu (--register);
; uninstall removes the keys directly so it works even if the exe is damaged.

!macro customInstall
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --register' $0
  ${if} ${Errors}
  ${orIf} $0 <> 0
    MessageBox MB_OK|MB_ICONSTOP "ContextHelper could not register its Explorer menu (code $0).$\r$\nDetails: $LOCALAPPDATA\ContextHelper\logs$\r$\nOpen ContextHelper from the Start menu to retry." /SD IDOK
    SetErrorLevel 5
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\ContextHelper"
    DeleteRegKey HKCU "Software\Classes\*\shell\ContextHelper"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ContextHelper"
    DeleteRegKey HKCU "Software\Classes\Directory\ContextHelperRoot"
    DeleteRegKey HKCU "Software\Classes\Directory\ContextHelperFolders"
    DeleteRegKey HKCU "Software\Classes\Directory\ContextHelperFiles"
  ${endIf}
!macroend
