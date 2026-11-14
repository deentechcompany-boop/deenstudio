# Deenstudio for Windows (v1.2)

Plug in one or more phones (Android, and iPhone with the Deenstudio iPhone app). This app finds them, opens the USB connection for each,
shows them together, and sends them to OBS or Prism.

## Run it (developer)
    npm install
    npm start

## Make the app folder to share (fast, recommended)
    npm run pack
The finished app is in `dist\win-unpacked`. Zip that folder; people extract it and open `Deenstudio.exe`.
(`npm run dist` makes a single portable .exe instead, but it can hang on some PCs.)

## What goes to OBS
| Want | In OBS add | Address |
|---|---|---|
| All phones merged into one picture | Browser Source, 1920 x 1080 | `http://127.0.0.1:8090/` |
| Phone 1 picture on its own | Media Source, format `h264` | `tcp://127.0.0.1:8001` |
| Phone 2, 3, 4... on their own | same | `tcp://127.0.0.1:8002`, `8003`, ... |
| Phone N sound | Media Source, no format | `http://127.0.0.1:8090/audio/N.wav` |

Mute buttons in the app silence that phone's sound for OBS too.
Prism Live Studio: use a Browser/Web source with the same addresses.

## Files saved
Photos and screenshots go to **Pictures > Deenstudio**.

## Tests
    npm test

## One app, three jobs
- **Devices tab**: every phone's picture, merged or separate, with Mute / Unmute, Mirror, Rotate 180 and Snap photo for each phone.
- **Visual screen tab**: pick your OBS or Prism window (or a whole screen) and snap a screenshot.
- **Top bar**: Snap phones (a photo from every live phone), Snap OBS / Prism, Mute all / Unmute all.

## iPhone
Install "Apple Devices" from the Microsoft Store (or iTunes), plug the iPhone in, tap Trust,
open Deenstudio on the iPhone and tap Start stream.
