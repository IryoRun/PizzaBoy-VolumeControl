@echo off
setlocal

rem Run from this file's own folder, so double-clicking works no matter where
rem the folder was unzipped to.
cd /d "%~dp0"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" goto :nocsc

rem Built once, from readable source, with the C# compiler Windows already
rem ships with -- no PowerShell, no download, no prebuilt binary to trust.
if not exist "src\VolumeControl.exe" (
    "%CSC%" /nologo /target:winexe /out:src\VolumeControl.exe ^
        /r:System.Windows.Forms.dll /r:System.Drawing.dll src\VolumeControl.cs
    if errorlevel 1 goto :compileerror
)

where node >nul 2>nul
if errorlevel 1 goto :nonode

start "" "src\VolumeControl.exe"
exit /b 0

:compileerror
echo.
echo Could not build PizzaBoy VolumeControl - the compiler output above says why.
echo.
pause
exit /b 1

:nocsc
echo.
echo   The .NET Framework C# compiler was not found on this computer.
echo   PizzaBoy VolumeControl needs it to build itself, once, on first run.
echo   It ships with Windows normally; if this keeps failing, install the
echo   ".NET Framework 4.8" runtime from https://dotnet.microsoft.com
echo.
pause
exit /b 1

:nonode
echo.
echo   Node.js was not found on this computer.
echo.
echo   PizzaBoy VolumeControl needs Node.js version 22 or newer.
echo   Get it here:  https://nodejs.org      (the "LTS" download is fine)
echo.
pause
exit /b 1
