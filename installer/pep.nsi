Unicode True

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_VERSION_QUAD
  !define APP_VERSION_QUAD "0.0.0.0"
!endif
!ifndef BUILD_ENVIRONMENT
  !define BUILD_ENVIRONMENT "production"
!endif
!ifndef SOURCE_EXE
  !define SOURCE_EXE "pep.exe"
!endif
!ifndef INSTALLER_OUTPUT
  !define INSTALLER_OUTPUT "pep-setup.exe"
!endif

!if "${BUILD_ENVIRONMENT}" == "development"
  !define APP_NAME "PEP CLI (Development)"
!else
  !define APP_NAME "PEP CLI"
!endif
!define APP_PUBLISHER "Newland NPT"
!define APP_REGISTRY_KEY "Software\Newland NPT\PEP CLI"
!define UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PEP CLI"

SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"

${Using:StrFunc} StrCase
${Using:StrFunc} StrStr
${Using:StrFunc} UnStrCase
${Using:StrFunc} UnStrStr

Name "${APP_NAME}"
OutFile "..\dist\${INSTALLER_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\PEP"
InstallDirRegKey HKCU "${APP_REGISTRY_KEY}" "InstallDir"
RequestExecutionLevel user
ManifestDPIAware true

VIProductVersion "${APP_VERSION_QUAD}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 ${APP_PUBLISHER}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Function AddToUserPath
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  StrCpy $2 ";$INSTDIR;"
  ${StrCase} $3 "$1" "U"
  ${StrCase} $4 "$2" "U"
  ${StrStr} $5 "$3" "$4"
  StrCmp $5 "" AddToUserPath_Add AddToUserPath_Done

  AddToUserPath_Add:
    StrCmp $0 "" 0 AddToUserPath_Append
    StrCpy $0 "$INSTDIR"
    Goto AddToUserPath_Write

  AddToUserPath_Append:
    StrCpy $0 "$0;$INSTDIR"

  AddToUserPath_Write:
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=100

  AddToUserPath_Done:
FunctionEnd

Function un.RemoveFromUserPath
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  StrCpy $2 ";$INSTDIR;"
  ${UnStrCase} $3 "$1" "U"
  ${UnStrCase} $4 "$2" "U"
  ${UnStrStr} $5 "$3" "$4"
  StrCmp $5 "" RemoveFromUserPath_Done

  StrLen $6 $1
  StrLen $7 $5
  IntOp $8 $6 - $7
  StrCpy $3 $1 $8
  StrLen $9 $2
  IntOp $8 $8 + $9
  StrCpy $4 $1 "" $8
  StrCpy $1 "$3;$4"

  StrCpy $2 $1 1
  StrCmp $2 ";" 0 RemoveFromUserPath_CheckEnd
  StrCpy $1 $1 "" 1

  RemoveFromUserPath_CheckEnd:
    StrLen $8 $1
    IntOp $8 $8 - 1
    StrCpy $2 $1 1 $8
    StrCmp $2 ";" 0 RemoveFromUserPath_Write
    StrCpy $1 $1 $8

  RemoveFromUserPath_Write:
    WriteRegExpandStr HKCU "Environment" "Path" "$1"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=100

  RemoveFromUserPath_Done:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File "/oname=pep.exe" "..\dist\${SOURCE_EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${APP_REGISTRY_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\pep.exe"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" "NoRepair" 1

  Call AddToUserPath
SectionEnd

Section "Uninstall"
  Call un.RemoveFromUserPath

  Delete "$INSTDIR\pep.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${APP_REGISTRY_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
SectionEnd
