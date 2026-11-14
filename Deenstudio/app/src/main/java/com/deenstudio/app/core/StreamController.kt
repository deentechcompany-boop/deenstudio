package com.deenstudio.app.core

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.provider.Settings
import android.util.Size
import android.view.Surface
import androidx.core.content.ContextCompat
import com.deenstudio.app.audio.AudioStreamer
import com.deenstudio.app.camera.CameraEngine
import com.deenstudio.app.codec.H264Encoder
import com.deenstudio.app.net.StreamServer
import java.util.concurrent.Executors
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * Process-wide owner of the capture -> encode -> serve pipeline.
 * The UI observes [ui]; the foreground service keeps the process alive while streaming.
 * All pipeline work runs on one worker thread so state changes never race.
 */
object StreamController {

    val ui = MutableStateFlow(UiState())

    /** Set by the service so it can shut itself down when streaming ends on its own. */
    @Volatile var onStreamEnded: (() -> Unit)? = null

    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "deenstudio-pipeline") }

    private var appCtx: Context? = null
    private var camera: CameraEngine? = null
    private var encoder: H264Encoder? = null
    private var server: StreamServer? = null
    private var audio: AudioStreamer? = null
    private var previewSurface: Surface? = null
    private var initialised = false

    // --- setup ----------------------------------------------------------------------------

    @Synchronized
    fun init(context: Context) {
        if (initialised) return
        initialised = true
        val ctx = context.applicationContext
        appCtx = ctx
        camera = CameraEngine(ctx).also { cam ->
            cam.onLost = { reason -> worker.execute { failLocked(reason) } }
        }
        registerUsbReceiver(ctx)
        refreshEnvironment()
        worker.execute { refreshCameraInfo() }
    }

    private fun registerUsbReceiver(ctx: Context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) = updateUsb(intent)
        }
        val sticky = ContextCompat.registerReceiver(
            ctx, receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_EXPORTED
        )
        if (sticky != null) updateUsb(sticky)
    }

    private fun updateUsb(intent: Intent) {
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) == BatteryManager.BATTERY_PLUGGED_USB
        ui.update { it.copy(usbPlugged = plugged) }
    }

    /** Re-reads permissions and USB-debugging state; call from onResume. */
    fun refreshEnvironment() {
        val ctx = appCtx ?: return
        val perm = ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        val mic = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        val adb = Settings.Global.getInt(ctx.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1
        val changedPerm = ui.value.cameraPermission != perm
        ui.update { it.copy(cameraPermission = perm, micPermission = mic, adbEnabled = adb) }
        if (changedPerm && perm) worker.execute { reconcile(restartEncoder = false) }
    }

    private fun refreshCameraInfo() {
        val ctx = appCtx ?: return
        val cam = camera ?: return
        val front = ui.value.settings.frontCamera
        val supported = runCatching { Capabilities.supportedModes(ctx, front) }.getOrDefault(ui.value.supported)
        val (evMin, evMax, evStep) = runCatching { cam.exposureInfo(front) }.getOrDefault(Triple(0, 0, 0f))
        val canFocus = runCatching { cam.hasAdjustableFocus(front) }.getOrDefault(false)
        ui.update {
            var s = it.settings
            if ((s.resolution to s.fps) !in supported) {
                val fallback = supported.firstOrNull { m -> m.second == 30 } ?: supported.first()
                s = s.copy(resolution = fallback.first, fps = fallback.second)
            }
            s = s.copy(
                exposureComp = s.exposureComp.coerceIn(evMin, evMax),
                focusLocked = s.focusLocked && canFocus
            )
            it.copy(
                settings = s, supported = supported,
                evMin = evMin, evMax = evMax, evStep = evStep, focusLockAvailable = canFocus
            )
        }
    }

    // --- preview --------------------------------------------------------------------------

    /** The UI hands over a preview surface when visible and takes it back when hidden. */
    fun attachPreview(surface: Surface) {
        worker.execute {
            previewSurface = surface
            reconcile(restartEncoder = false)
        }
    }

    fun detachPreview(onDetached: () -> Unit) {
        worker.execute {
            val old = previewSurface
            previewSurface = null
            reconcile(restartEncoder = false)
            runCatching { old?.release() }
            onDetached()
        }
    }

    // --- photos ---------------------------------------------------------------------------

    fun takePhoto() {
        worker.execute {
            val cam = camera
            val ctx = appCtx
            if (cam == null || ctx == null) return@execute
            val state = ui.value
            cam.takePhoto(state.settings, state.streaming) photo@{ bytes, err ->
                if (bytes == null) {
                    say(err ?: "Photo failed")
                    return@photo
                }
                // Write to storage off the camera thread.
                thread(name = "deenstudio-photo-save", isDaemon = true) {
                    val where = PhotoSaver.save(ctx, bytes)
                    say(if (where != null) "Photo saved in $where" else "Could not save the photo")
                }
            }
        }
    }

    private fun say(message: String) = ui.update { it.copy(photoMessage = message) }

    fun clearPhotoMessage() = ui.update { it.copy(photoMessage = null) }

    // --- streaming ------------------------------------------------------------------------

    fun startStream() {
        worker.execute {
            if (ui.value.streaming) return@execute
            if (!ui.value.cameraPermission) {
                failLocked("Camera permission is required")
                return@execute
            }
            server?.stop()
            server = StreamServer(
                port = STREAM_PORT,
                onMetrics = { m -> ui.update { it.copy(metrics = m) } },
                onClientConnected = { encoder?.requestKeyFrame() },
                onFatal = { msg -> worker.execute { failLocked(msg) } }
            ).also { it.start() }

            // Microphone is optional: if it cannot start, the video still streams.
            audio?.stop()
            audio = null
            val st = ui.value
            if (st.settings.micOn && st.micPermission) {
                val a = AudioStreamer(AUDIO_PORT)
                a.muted = st.settings.micMuted
                audio = if (a.start()) a else null
            }

            ui.update { it.copy(streaming = true, error = null, metrics = Metrics()) }
            reconcile(restartEncoder = true)
        }
    }

    fun stopStream() {
        worker.execute { stopLocked() }
    }

    private fun stopLocked() {
        server?.stop()
        server = null
        audio?.stop()
        audio = null
        encoder?.stop()
        encoder = null
        ui.update { it.copy(streaming = false, metrics = Metrics()) }
        reconcile(restartEncoder = false)
        onStreamEnded?.invoke()
    }

    private fun failLocked(message: String) {
        ui.update { it.copy(error = message) }
        if (ui.value.streaming) stopLocked() else {
            camera?.close()
        }
    }

    fun clearError() = ui.update { it.copy(error = null) }

    // --- settings -------------------------------------------------------------------------

    fun update(transform: (StudioSettings) -> StudioSettings) {
        val old = ui.value.settings
        val new = transform(old)
        if (new == old) return
        ui.update { it.copy(settings = new) }
        audio?.muted = new.micMuted
        worker.execute {
            val cameraChanged = new.frontCamera != old.frontCamera
            val encodeChanged = new.resolution != old.resolution || new.fps != old.fps
            if (cameraChanged) refreshCameraInfo()
            if (cameraChanged || encodeChanged) {
                reconcile(restartEncoder = encodeChanged)
            } else {
                camera?.applySettings(ui.value.settings)
            }
        }
    }

    // --- pipeline (worker thread only) ----------------------------------------------------

    /**
     * Brings the real pipeline in line with the wanted state:
     * camera runs while streaming or while a preview is visible; encoder only while streaming.
     */
    private fun reconcile(restartEncoder: Boolean) {
        val cam = camera ?: return
        val state = ui.value
        val s = state.settings
        val preview = previewSurface?.takeIf { it.isValid }

        if (!state.streaming && preview == null) {
            cam.close()
            ui.update { it.copy(photoAvailable = false) }
            return
        }
        if (!state.cameraPermission) return

        if (state.streaming) {
            if (restartEncoder || encoder == null) {
                encoder?.stop()
                encoder = try {
                    H264Encoder(s.resolution.width, s.resolution.height, s.fps, s.bitrate) { data, key ->
                        server?.push(data, key)
                    }
                } catch (e: Exception) {
                    failLocked(e.message ?: "Encoder failed")
                    return
                }
                if (server != null) encoder?.requestKeyFrame()
            }
        } else if (encoder != null) {
            encoder?.stop()
            encoder = null
        }

        if (!cam.isOpenFor(s.frontCamera)) {
            cam.openBlocking(s.frontCamera)?.let { failLocked(it); return }
        }
        val targets = listOfNotNull(preview, encoder?.inputSurface)

        // Photos use the video size while streaming (safe on every phone), the biggest size otherwise.
        val limit = if (state.streaming) Size(s.resolution.width, s.resolution.height) else null
        val photoSize = cam.choosePhotoSize(s.frontCamera, limit)
        var err = cam.startSessionBlocking(targets, s, photoSize)
        if (err != null && photoSize != null) {
            // Some phones cannot do video + photo together at this mode: keep streaming without photos.
            err = cam.startSessionBlocking(targets, s, null)
        }
        err?.let { failLocked(it); return }

        ui.update { it.copy(photoAvailable = cam.hasPhoto()) }
        encoder?.requestKeyFrame()
    }
}
