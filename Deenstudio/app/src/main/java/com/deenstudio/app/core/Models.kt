package com.deenstudio.app.core

import android.hardware.camera2.CameraMetadata

const val STREAM_PORT = 8000

enum class Resolution(val label: String, val width: Int, val height: Int, val baseBitrate: Int) {
    P720("720p", 1280, 720, 5_000_000),
    P1080("1080p", 1920, 1080, 10_000_000),
    UHD("4K", 3840, 2160, 30_000_000)
}

enum class WhiteBalance(val label: String, val awbMode: Int) {
    AUTO("Auto", CameraMetadata.CONTROL_AWB_MODE_AUTO),
    DAYLIGHT("Daylight", CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT),
    CLOUDY("Cloudy", CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT),
    TUNGSTEN("Tungsten", CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT),
    FLUORESCENT("Fluorescent", CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT)
}

data class StudioSettings(
    val frontCamera: Boolean = false,
    val resolution: Resolution = Resolution.P1080,
    val fps: Int = 30,
    val focusLocked: Boolean = false,
    /** 0 = infinity, 1 = closest focus the lens supports. */
    val focusPosition: Float = 0.2f,
    /** Exposure compensation in camera steps (see UiState.evStep for the size of one step). */
    val exposureComp: Int = 0,
    val whiteBalance: WhiteBalance = WhiteBalance.AUTO
) {
    /** Target video bitrate in bits per second. */
    val bitrate: Int get() = (resolution.baseBitrate * if (fps >= 60) 1.6 else 1.0).toInt()
}

data class Metrics(
    val clientConnected: Boolean = false,
    val bitrateKbps: Int = 0,
    val droppedFrames: Long = 0,
    val framesSent: Long = 0,
    val port: Int = STREAM_PORT
)

data class UiState(
    val settings: StudioSettings = StudioSettings(),
    val streaming: Boolean = false,
    val cameraPermission: Boolean = false,
    val usbPlugged: Boolean = false,
    val adbEnabled: Boolean = false,
    val metrics: Metrics = Metrics(),
    val supported: Set<Pair<Resolution, Int>> = setOf(Resolution.P720 to 30, Resolution.P1080 to 30),
    val evMin: Int = 0,
    val evMax: Int = 0,
    val evStep: Float = 0f,
    val focusLockAvailable: Boolean = true,
    val error: String? = null
) {
    val endpoint: String get() = "127.0.0.1:${metrics.port}"
}
