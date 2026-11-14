package com.deenstudio.app.core

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.util.Range
import com.deenstudio.app.camera.CameraEngine

/** Works out which resolution / frame-rate pairs this phone can really encode and capture. */
object Capabilities {

    fun supportedModes(ctx: Context, front: Boolean): Set<Pair<Resolution, Int>> {
        val out = mutableSetOf<Pair<Resolution, Int>>()
        for (res in Resolution.values()) {
            for (fps in listOf(30, 60)) {
                if (isSupported(ctx, front, res, fps)) out += res to fps
            }
        }
        // Never leave the user with nothing selectable.
        if (out.isEmpty()) out += Resolution.P720 to 30
        return out
    }

    private fun isSupported(ctx: Context, front: Boolean, res: Resolution, fps: Int): Boolean {
        val codecOk = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
            .filter { it.isEncoder && MediaFormat.MIMETYPE_VIDEO_AVC in it.supportedTypes }
            .any {
                runCatching {
                    it.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
                        .videoCapabilities
                        .areSizeAndRateSupported(res.width, res.height, fps.toDouble())
                }.getOrDefault(false)
            }
        if (!codecOk) return false

        val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = CameraEngine.findCameraId(mgr, front) ?: return false
        val chars = mgr.getCameraCharacteristics(id)
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return false
        val sizeOk = map.getOutputSizes(MediaCodec::class.java)
            ?.any { it.width == res.width && it.height == res.height } == true
        if (!sizeOk) return false

        val ranges: Array<Range<Int>> =
            chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return false
        return ranges.any { it.upper >= fps }
    }
}
