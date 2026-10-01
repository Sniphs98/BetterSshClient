; Custom NSIS macros, included by electron-builder (buildResources/installer.nsh).
;
; In-app updates. electron-updater runs this installer with --updated and, since the
; app asks for it, not silently (packages/electron/src/ipc/update.ts): a silent install
; takes half a minute with nothing on screen. Shown, though, the assisted installer
; would ask everything a first install asks. So for an update it skips the questions
; and the finish page — leaving only its progress window — and opens the new version
; itself. A normal install from the setup .exe is unchanged.

; "For whom": the same as the installation being updated. (The license and directory
; pages already skip themselves for an update.)
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} ${isUpdated}
      ${if} $hasPerMachineInstallation == "1"
        StrCpy $isForceMachineInstall "1"
      ${else}
        StrCpy $isForceCurrentInstall "1"
      ${endif}
    ${endif}
  !endif
!macroend

; The default finish page (its "Run Remoty" checkbox included), except that for an
; update it starts the app right away and closes instead of waiting for a click.
!macro customFinishPage
  Function remotyStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function remotyFinishPagePre
    ${if} ${isUpdated}
      Call remotyStartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE remotyFinishPagePre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "remotyStartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
