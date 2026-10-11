package com.deenstudio.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.deenstudio.app.core.STREAM_PORT
import com.deenstudio.app.core.StreamController
import com.deenstudio.app.ui.MainActivity

/**
 * Foreground service of type "camera". It keeps the process (and therefore the camera,
 * encoder and socket) alive when the app is minimised or the screen is off.
 */
class StreamService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                StreamController.stopStream()
                shutDown()
            }
            else -> begin()
        }
        // Not sticky: a camera service cannot be restarted from the background on Android 14+.
        return START_NOT_STICKY
    }

    private fun begin() {
        createChannel()
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)

        if (wakeLock == null) {
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "deenstudio:stream")
                .apply { acquire() }
        }
        StreamController.init(applicationContext)
        StreamController.onStreamEnded = { shutDown() }
        StreamController.startStream()
    }

    private fun shutDown() {
        StreamController.onStreamEnded = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "USB streaming", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, StreamService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Deenstudio is streaming")
            .setContentText("USB tunnel on 127.0.0.1:$STREAM_PORT")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop stream", stop)
            .build()
    }

    companion object {
        const val ACTION_START = "com.deenstudio.app.START"
        const val ACTION_STOP = "com.deenstudio.app.STOP"
        private const val CHANNEL_ID = "deenstudio_stream"
        private const val NOTIFICATION_ID = 1
    }
}
