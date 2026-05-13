@echo off
REM Auto-generated. Removes all ContextHelper HKCU registrations.

reg delete "HKCU\Software\Classes\Directory\shell\ContextHelper" /f 2>nul
reg delete "HKCU\Software\Classes\*\shell\ContextHelper" /f 2>nul
reg delete "HKCU\Software\Classes\Directory\Background\shell\ContextHelper" /f 2>nul
reg delete "HKCU\Software\Classes\Directory\ContextHelperRoot" /f 2>nul
reg delete "HKCU\Software\Classes\Directory\ContextHelperFolders" /f 2>nul
reg delete "HKCU\Software\Classes\Directory\ContextHelperFiles" /f 2>nul
echo Done.
