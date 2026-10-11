@echo off
rem Deenstudio USB bridge for Windows.
rem Keeps an ADB tunnel open so OBS can reach the phone at tcp://127.0.0.1:PORT.
set PORT=%1
if "%PORT%"=="" set PORT=8000

where adb >nul 2>nul
if errorlevel 1 (
  echo adb not found. Install Android platform-tools and add it to your PATH.
  exit /b 1
)

echo Deenstudio USB bridge. Waiting for your phone (USB debugging must be on)...
:loop
adb wait-for-device
adb forward tcp:%PORT% tcp:%PORT% >nul 2>nul
if errorlevel 1 (
  echo [!] Could not create the tunnel. Run: adb devices
) else (
  echo [ok] Tunnel is up: tcp://127.0.0.1:%PORT%
)
:wait
timeout /t 2 /nobreak >nul
adb get-state 2>nul | find "device" >nul
if not errorlevel 1 goto wait
echo [..] Phone unplugged. Waiting for it to come back...
goto loop
