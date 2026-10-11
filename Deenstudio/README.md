# Deenstudio

Use your Android phone as a wired, low-latency webcam for OBS Studio, Zoom, Teams and more.

```
Camera2 -> MediaCodec (H.264, hardware) -> TCP server on phone (127.0.0.1:8000)
        -> USB cable (adb forward) -> PC 127.0.0.1:8000 -> OBS Media Source
        -> OBS Virtual Camera -> Zoom / Teams / Meet
```

## 1. Build the app

1. Install **Android Studio** (Koala or newer) and open the `Deenstudio` folder.
2. Let Gradle sync (it downloads Gradle 8.7 and the dependencies).
   If sync complains about the wrapper, run `gradle wrapper --gradle-version 8.7` once in the folder.
3. On the phone: Settings > About phone > tap *Build number* 7 times, then
   Developer options > turn on **USB debugging**.
4. Plug the phone in, accept the "Allow USB debugging" prompt, and press **Run**.

Requires Android 8.0+ (API 26).

## 2. On the PC

1. Install Android **platform-tools** (adb) and add it to PATH.
2. Run the bridge and leave it open:
   - macOS / Linux: `./pc/deenstudio-connect.sh`
   - Windows: `pc\deenstudio-connect.bat`
   (or just run `adb forward tcp:8000 tcp:8000` once)
3. On the phone, open Deenstudio, allow the camera, and tap **Start stream**.

## 3. OBS Studio

1. Sources **+** > **Media Source**.
2. Untick **Local File**.
3. **Input:** `tcp://127.0.0.1:8000`
4. **Input Format:** `h264`
5. Untick *Use hardware decoding when available* if you see glitches.
6. Tick *Restart playback when source becomes active*; untick *Close file when inactive*.
7. Set network buffering to the minimum for the lowest delay.

Quick test without OBS:
`ffplay -fflags nobuffer -flags low_delay -probesize 32 -f h264 tcp://127.0.0.1:8000`

**Zoom / Teams / Meet:** in OBS click **Start Virtual Camera**, then choose *OBS Virtual Camera* in the meeting app.

## Using the app

- Landscape only. Hold or mount the phone in landscape. If the picture is upside down in OBS, right-click the source > Transform > Rotate 180. Front camera is not mirrored; use Transform > Flip Horizontal.
- **Status light:** green = OBS is receiving, amber = cable connected / waiting for the PC, red = no USB cable.
- Resolution and frame-rate chips grey out when your phone cannot encode that mode. 4K60 is rare.
- Lock focus, exposure and white balance apply live. Changing resolution or fps restarts the pipeline for about a second; refresh the OBS source if it freezes.
- Minimise the app and the stream keeps running (foreground service + notification with a **Stop stream** button).
- The video socket only listens on the phone's loopback address, so nobody on your Wi-Fi can see the stream.

## Troubleshooting

| Problem | Fix |
|---|---|
| OBS shows nothing | Is the tunnel running? Run `adb devices` (must say `device`), then restart the bridge. Is the stream started on the phone? |
| `unauthorized` in `adb devices` | Unlock the phone and accept the RSA prompt. |
| Choppy / dropped frames climbing | Lower resolution or fps, use a good data cable, plug into a USB 3 port. |
| Delay of 1s+ | Set OBS network buffering to minimum; make sure hardware decoding is not stalling; prefer 1080p30. |
| Stream stops after a while | Exempt Deenstudio from battery optimisation in Android settings. |

## Project layout

```
app/src/main/java/com/deenstudio/app/
  camera/CameraEngine.kt        Camera2 + focus / exposure / white balance
  codec/H264Encoder.kt          MediaCodec surface encoder, low-latency settings
  net/StreamServer.kt           Loopback TCP server, drop-oldest queue, live metrics
  core/StreamController.kt      Pipeline owner (camera -> encoder -> server) + USB state
  core/Capabilities.kt          Which resolution / fps this phone really supports
  service/StreamService.kt      Foreground service for background streaming
  ui/StudioScreen.kt            Dark obsidian + neon Compose UI
pc/                             ADB bridge scripts for Windows / macOS / Linux
```

## Status

This project was written without access to an Android SDK, so it has not been compiled or run on a device yet.
Expect to fix a small compile warning or two on first build. Not included: app icon, audio, iOS version.
