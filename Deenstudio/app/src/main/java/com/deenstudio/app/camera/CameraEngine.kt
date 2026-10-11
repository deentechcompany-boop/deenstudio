package com.deenstudio.app.camera

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.view.Surface
import com.deenstudio.app.core.StudioSettings
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Camera2 wrapper with manual controls (focus lock, exposure compensation, white balance).
 * open / startSession are blocking so the pipeline code that calls them stays linear;
 * never call them from the main thread.
 */
class CameraEngine(context: Context) {

    private val mgr = context.applicationContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val thread = HandlerThread("deenstudio-camera").also { it.start() }
    private val handler = Handler(thread.looper)

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var builder: CaptureRequest.Builder? = null
    private var cameraId: String? = null
    private var openedFront: Boolean? = null

    /** Called if the camera disappears after it was opened (unplugged, taken by another app). */
    @Volatile var onLost: ((String) -> Unit)? = null

    fun isOpenFor(front: Boolean) = device != null && openedFront == front

    @SuppressLint("MissingPermission")
    fun openBlocking(front: Boolean): String? {
        val latch = CountDownLatch(1)
        val error = AtomicReference<String?>(null)
        handler.post {
            closeInternal()
            val id = findCameraId(mgr, front)
            if (id == null) {
                error.set("No ${if (front) "front" else "rear"} camera found")
                latch.countDown()
                return@post
            }
            try {
                mgr.openCamera(id, object : CameraDevice.StateCallback() {
                    override fun onOpened(camera: CameraDevice) {
                        device = camera
                        cameraId = id
                        openedFront = front
                        latch.countDown()
                    }

                    override fun onDisconnected(camera: CameraDevice) {
                        camera.close()
                        val wasOpen = device === camera
                        device = null
                        session = null
                        if (wasOpen) onLost?.invoke("Camera disconnected")
                        latch.countDown()
                    }

                    override fun onError(camera: CameraDevice, code: Int) {
                        camera.close()
                        val wasOpen = device === camera
                        device = null
                        session = null
                        if (wasOpen) onLost?.invoke("Camera error ($code)")
                        error.compareAndSet(null, "Camera error ($code)")
                        latch.countDown()
                    }
                }, handler)
            } catch (e: Exception) {
                error.set(e.message ?: "Could not open camera")
                latch.countDown()
            }
        }
        if (!latch.await(5, TimeUnit.SECONDS)) return "Camera open timed out"
        return error.get()
    }

    /** Creates a repeating capture session that feeds every surface in [targets]. */
    @Suppress("DEPRECATION")
    fun startSessionBlocking(targets: List<Surface>, settings: StudioSettings): String? {
        val latch = CountDownLatch(1)
        val error = AtomicReference<String?>(null)
        handler.post {
            val dev = device
            if (dev == null) {
                error.set("Camera is not open")
                latch.countDown()
                return@post
            }
            try {
                session?.close()
                session = null
                dev.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(s: CameraCaptureSession) {
                        session = s
                        try {
                            val b = dev.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
                            targets.forEach { b.addTarget(it) }
                            builder = b
                            applyLocked(settings)
                        } catch (e: Exception) {
                            error.set(e.message ?: "Could not start capture")
                        }
                        latch.countDown()
                    }

                    override fun onConfigureFailed(s: CameraCaptureSession) {
                        error.set("Camera rejected this resolution / frame rate")
                        latch.countDown()
                    }
                }, handler)
            } catch (e: Exception) {
                error.set(e.message ?: "Could not create camera session")
                latch.countDown()
            }
        }
        if (!latch.await(6, TimeUnit.SECONDS)) return "Camera session timed out"
        return error.get()
    }

    /** Applies focus / exposure / white balance changes live, without restarting the session. */
    fun applySettings(settings: StudioSettings) {
        handler.post { applyLocked(settings) }
    }

    private fun applyLocked(s: StudioSettings) {
        val b = builder ?: return
        val sess = session ?: return
        val id = cameraId ?: return
        val chars = mgr.getCameraCharacteristics(id)

        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
        b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, pickFpsRange(chars, s.fps))

        val minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        if (s.focusLocked && minFocus > 0f) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
            b.set(CaptureRequest.LENS_FOCUS_DISTANCE, s.focusPosition.coerceIn(0f, 1f) * minFocus)
        } else {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
        }

        b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, s.exposureComp)
        b.set(CaptureRequest.CONTROL_AWB_MODE, s.whiteBalance.awbMode)

        try {
            sess.setRepeatingRequest(b.build(), null, handler)
        } catch (_: Exception) {
            // Session was closed underneath us; the pipeline will rebuild it.
        }
    }

    fun close() {
        val latch = CountDownLatch(1)
        handler.post {
            closeInternal()
            latch.countDown()
        }
        latch.await(2, TimeUnit.SECONDS)
    }

    private fun closeInternal() {
        runCatching { session?.close() }
        runCatching { device?.close() }
        session = null
        device = null
        builder = null
        openedFront = null
    }

    fun release() {
        close()
        thread.quitSafely()
    }

    // --- static helpers -------------------------------------------------------------------

    /** Returns (min, max, stepSize) for exposure compensation of the chosen camera. */
    fun exposureInfo(front: Boolean): Triple<Int, Int, Float> {
        val id = findCameraId(mgr, front) ?: return Triple(0, 0, 0f)
        val chars = mgr.getCameraCharacteristics(id)
        val range = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
        val step = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toFloat() ?: 0f
        return Triple(range?.lower ?: 0, range?.upper ?: 0, step)
    }

    fun hasAdjustableFocus(front: Boolean): Boolean {
        val id = findCameraId(mgr, front) ?: return false
        val minFocus = mgr.getCameraCharacteristics(id)
            .get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        return minFocus > 0f
    }

    companion object {
        fun findCameraId(mgr: CameraManager, front: Boolean): String? {
            val wanted = if (front) CameraCharacteristics.LENS_FACING_FRONT
            else CameraCharacteristics.LENS_FACING_BACK
            return mgr.cameraIdList.firstOrNull {
                mgr.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == wanted
            }
        }

        /** Prefer a fixed range (fps..fps) so frame timing stays steady for streaming. */
        private fun pickFpsRange(chars: CameraCharacteristics, fps: Int): Range<Int> {
            val ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                ?: return Range(fps, fps)
            return ranges.firstOrNull { it.lower == fps && it.upper == fps }
                ?: ranges.filter { it.upper == fps }.maxByOrNull { it.lower }
                ?: ranges.filter { it.upper > fps }.minByOrNull { it.upper }
                ?: ranges.maxByOrNull { it.upper }
                ?: Range(fps, fps)
        }
    }
}
