package com.deenstudio.app.codec

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface

/**
 * Hardware H.264 encoder fed by a Surface (camera frames never touch the CPU).
 * Output is Annex-B, so it can be written straight to a TCP socket and read by OBS / FFmpeg.
 * SPS/PPS are re-attached to every keyframe so a viewer can join at any moment.
 */
class H264Encoder(
    private val width: Int,
    private val height: Int,
    private val fps: Int,
    private val bitrate: Int,
    private val onFrame: (data: ByteArray, isKey: Boolean) -> Unit
) {
    private val thread = HandlerThread("deenstudio-encoder").also { it.start() }
    private val handler = Handler(thread.looper)

    @Volatile private var config: ByteArray? = null
    @Volatile private var stopped = false

    // Declared before `init` on purpose: create() uses it while the constructor is running.
    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(c: MediaCodec, index: Int) {}

        override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            try {
                val buf = c.getOutputBuffer(index)
                if (buf != null && info.size > 0 && !stopped) {
                    buf.position(info.offset)
                    buf.limit(info.offset + info.size)
                    val data = ByteArray(info.size)
                    buf.get(data)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        config = data
                    } else {
                        val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                        val cfg = config
                        onFrame(if (key && cfg != null) cfg + data else data, key)
                    }
                }
            } finally {
                try { c.releaseOutputBuffer(index, false) } catch (_: Exception) {}
            }
        }

        override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {}
        override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {}
    }

    private val codec: MediaCodec
    val inputSurface: Surface

    init {
        val c = create(cbr = true) ?: create(cbr = false)
            ?: run {
                thread.quitSafely()
                throw IllegalStateException("This phone cannot encode ${width}x$height at $fps fps")
            }
        codec = c
        inputSurface = c.createInputSurface()
        c.start()
    }

    private fun create(cbr: Boolean): MediaCodec? {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            setInteger(
                MediaFormat.KEY_BITRATE_MODE,
                if (cbr) MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                else MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
            )
            setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
            if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LATENCY, 1)
            if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
        }
        var created: MediaCodec? = null
        return try {
            val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            created = c
            c.setCallback(callback, handler)
            c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            c
        } catch (e: Exception) {
            try { created?.release() } catch (_: Exception) {}
            null
        }
    }

    /** Ask for an immediate keyframe (used when OBS connects). */
    fun requestKeyFrame() {
        if (stopped) return
        try {
            codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (_: Exception) {}
    }

    /** Change bitrate on the fly (for adaptive bitrate). */
    fun setBitrate(bps: Int) {
        if (stopped) return
        try {
            codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) })
        } catch (_: Exception) {}
    }

    fun stop() {
        if (stopped) return
        stopped = true
        try { codec.stop() } catch (_: Exception) {}
        try { codec.release() } catch (_: Exception) {}
        try { inputSurface.release() } catch (_: Exception) {}
        thread.quitSafely()
    }
}
