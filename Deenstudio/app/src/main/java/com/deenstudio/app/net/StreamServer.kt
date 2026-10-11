package com.deenstudio.app.net

import com.deenstudio.app.core.Metrics
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * Tiny TCP server on the phone's loopback interface. The PC reaches it through
 * `adb forward tcp:PORT tcp:PORT`, which tunnels the connection over the USB cable.
 * Bound to 127.0.0.1 on purpose: nothing on Wi-Fi can see the video.
 *
 * One viewer at a time. A short queue keeps latency flat: if the viewer cannot keep up,
 * the oldest frame is dropped (and counted) instead of letting delay build up.
 */
class StreamServer(
    private val port: Int,
    private val onMetrics: (Metrics) -> Unit,
    private val onClientConnected: () -> Unit,
    private val onFatal: (String) -> Unit
) {
    private val queue = ArrayBlockingQueue<ByteArray>(6)
    @Volatile private var running = false
    @Volatile private var clientActive = false
    @Volatile private var waitingForKey = true
    private var serverSocket: ServerSocket? = null

    private val dropped = AtomicLong()
    private val sent = AtomicLong()
    private val bytesWindow = AtomicLong()

    fun start() {
        running = true
        thread(name = "deenstudio-accept", isDaemon = true) { acceptLoop() }
        thread(name = "deenstudio-metrics", isDaemon = true) { metricsLoop() }
    }

    /** Called from the encoder thread for every encoded frame. */
    fun push(frame: ByteArray, isKey: Boolean) {
        if (!clientActive) return
        if (waitingForKey) {
            if (!isKey) return          // a viewer must start on a keyframe
            waitingForKey = false
        }
        if (!queue.offer(frame)) {
            queue.poll()                // drop oldest
            queue.offer(frame)
            dropped.incrementAndGet()
        }
    }

    private fun acceptLoop() {
        try {
            val server = ServerSocket(port, 1, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
            server.reuseAddress = true
            serverSocket = server
            while (running) {
                val client = try {
                    server.accept()
                } catch (e: IOException) {
                    break
                }
                serve(client)
            }
        } catch (e: IOException) {
            if (running) onFatal("Port $port is unavailable: ${e.message}")
        }
    }

    private fun serve(client: Socket) {
        try {
            client.tcpNoDelay = true
            queue.clear()
            waitingForKey = true
            clientActive = true
            publish(connected = true)
            onClientConnected()
            val out = client.getOutputStream().buffered(64 * 1024)
            while (running && !client.isClosed) {
                val frame = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                out.write(frame)
                out.flush()
                bytesWindow.addAndGet(frame.size.toLong())
                sent.incrementAndGet()
            }
        } catch (_: IOException) {
            // Viewer closed the source or the cable was pulled.
        } catch (_: InterruptedException) {
        } finally {
            clientActive = false
            queue.clear()
            runCatching { client.close() }
            publish(connected = false)
        }
    }

    private fun metricsLoop() {
        while (running) {
            try {
                Thread.sleep(1000)
            } catch (_: InterruptedException) {
                return
            }
            val bits = bytesWindow.getAndSet(0) * 8
            publish(connected = clientActive, kbps = (bits / 1000).toInt())
        }
    }

    private fun publish(connected: Boolean, kbps: Int = 0) {
        onMetrics(Metrics(connected, kbps, dropped.get(), sent.get(), port))
    }

    fun stop() {
        running = false
        clientActive = false
        runCatching { serverSocket?.close() }
        queue.clear()
    }
}
