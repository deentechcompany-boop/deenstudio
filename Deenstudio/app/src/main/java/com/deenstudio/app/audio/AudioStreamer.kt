package com.deenstudio.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Sends the phone microphone to the PC as raw PCM (16-bit, mono, 48 kHz) on a loopback port.
 * The PC reaches it through the same USB tunnel as the video. Raw PCM keeps this simple and
 * avoids any audio codec problems; it is only about 770 kbit/s, which is nothing for USB.
 */
class AudioStreamer(private val port: Int) {

    @Volatile private var running = false
    /** When true the PC receives silence instead of the microphone. */
    @Volatile var muted = false
    @Volatile private var client: Socket? = null
    private var server: ServerSocket? = null

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return false
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC, RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min, FRAME_BYTES * 8)
            )
        } catch (e: Exception) {
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        running = true

        thread(name = "deenstudio-audio-accept", isDaemon = true) {
            try {
                val s = ServerSocket(port, 1, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
                s.reuseAddress = true
                server = s
                while (running) {
                    val c = s.accept()
                    c.tcpNoDelay = true
                    try { client?.close() } catch (_: IOException) {}
                    client = c
                }
            } catch (_: IOException) {
                // closed on stop()
            }
        }

        thread(name = "deenstudio-audio-capture", isDaemon = true) {
            val buf = ByteArray(FRAME_BYTES)
            try {
                rec.startRecording()
                while (running) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    if (muted) java.util.Arrays.fill(buf, 0, n, 0.toByte())
                    val c = client ?: continue
                    try {
                        c.getOutputStream().write(buf, 0, n)
                    } catch (_: IOException) {
                        try { c.close() } catch (_: IOException) {}
                        if (client === c) client = null
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { rec.stop() } catch (_: Exception) {}
                rec.release()
            }
        }
        return true
    }

    fun stop() {
        running = false
        try { server?.close() } catch (_: IOException) {}
        try { client?.close() } catch (_: IOException) {}
        client = null
    }

    companion object {
        const val RATE = 48000
        private const val FRAME_BYTES = 1920 // 20 ms of 16-bit mono
    }
}
