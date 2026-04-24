@echo off
title Court Launcher

:: -- Find ngrok ------------------------------------------------
set NGROK=

if exist "%~dp0ngrok.exe" (
    set NGROK=%~dp0ngrok.exe
    goto :found
)

where ngrok >nul 2>&1
if not errorlevel 1 (
    set NGROK=ngrok
    goto :found
)

if exist "%LOCALAPPDATA%\ngrok\ngrok.exe" (
    set NGROK=%LOCALAPPDATA%\ngrok\ngrok.exe
    goto :found
)

if exist "%USERPROFILE%\ngrok\ngrok.exe" (
    set NGROK=%USERPROFILE%\ngrok\ngrok.exe
    goto :found
)

echo [ERROR] ngrok.exe not found.
echo Copy ngrok.exe to: %~dp0
pause
exit /b 1

:found
echo [OK] ngrok: %NGROK%
echo.

:: -- Start Node.js server -------------------------------------
start "Court Server" /d "%~dp0" cmd /k "node server.js"

:: -- Wait 3 seconds -------------------------------------------
timeout /t 3 /nobreak >nul

:: -- Start ngrok ----------------------------------------------
start "ngrok" cmd /k ""%NGROK%" http 3000"

echo.
echo Running. Check the ngrok window for the public URL.
pause
