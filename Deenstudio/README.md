# Deenstudio for Android (v1.1)

Phone camera and microphone to your PC over USB, for OBS, Prism, Zoom and more.

New in 1.1
- **Photo button** (round shutter on the preview). Photos are saved in Pictures > Deenstudio.
- **Microphone switch**: sends the phone's sound to the Windows app (switch it before Start stream).
- App icon.

## Build
Open this folder in Android Studio, or push it to GitHub and let the included workflow
(`.github/workflows`) build `app-debug.apk` for you.

## Use
1. Install the APK, allow Camera and Microphone.
2. Turn on USB debugging, plug into the PC running the Deenstudio Windows app.
3. Tap Start stream. The Windows app does the rest.

Video is served on the phone at 127.0.0.1:8000 and sound at 127.0.0.1:8002 (loopback only,
reached through the USB tunnel), so nothing is visible on Wi-Fi.

## Status
Written without an Android SDK, so it is not compiled or run on a device yet.
