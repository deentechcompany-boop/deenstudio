package com.deenstudio.app.ui

import android.Manifest
import android.content.Intent
import android.graphics.SurfaceTexture
import android.os.Build
import android.view.Surface
import android.view.TextureView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deenstudio.app.core.Resolution
import com.deenstudio.app.core.StreamController
import com.deenstudio.app.core.UiState
import com.deenstudio.app.core.WhiteBalance
import com.deenstudio.app.service.StreamService

private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.CAMERA, Manifest.permission.POST_NOTIFICATIONS)
    else arrayOf(Manifest.permission.CAMERA)

private data class Led(val color: Color, val text: String, val pulse: Boolean)

private fun ledFor(ui: UiState): Led = when {
    ui.streaming && ui.metrics.clientConnected -> Led(Studio.Live, "Live in OBS", true)
    !ui.usbPlugged -> Led(Studio.Danger, "No USB cable", false)
    ui.streaming -> Led(Studio.Amber, "Waiting for the PC", true)
    else -> Led(Studio.Amber, "Cable connected", false)
}

@Composable
fun StudioScreen() {
    val ctx = LocalContext.current
    val ui by StreamController.ui.collectAsStateWithLifecycle()

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { StreamController.refreshEnvironment() }

    LaunchedEffect(Unit) {
        if (!ui.cameraPermission) permissionLauncher.launch(requiredPermissions())
    }

    val onToggle = {
        when {
            ui.streaming -> ctx.startService(
                Intent(ctx, StreamService::class.java).setAction(StreamService.ACTION_STOP)
            )
            !ui.cameraPermission -> permissionLauncher.launch(requiredPermissions())
            else -> ContextCompat.startForegroundService(
                ctx, Intent(ctx, StreamService::class.java).setAction(StreamService.ACTION_START)
            )
        }
        Unit
    }

    Row(
        Modifier.fillMaxSize().background(Studio.Obsidian).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        PreviewPane(
            ui = ui,
            onAllowCamera = { permissionLauncher.launch(requiredPermissions()) },
            modifier = Modifier.weight(1f).fillMaxHeight()
        )
        SidePanel(ui = ui, onToggle = onToggle, modifier = Modifier.width(330.dp).fillMaxHeight())
    }
}

// --- preview ---------------------------------------------------------------------------------

@Composable
private fun PreviewPane(ui: UiState, onAllowCamera: () -> Unit, modifier: Modifier) {
    val led = ledFor(ui)
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier
            .clip(shape)
            .background(Color.Black)
            .border(1.dp, if (ui.streaming && ui.metrics.clientConnected) Studio.Live.copy(alpha = .7f) else Studio.Line, shape)
    ) {
        AndroidView(
            factory = { c ->
                TextureView(c).apply {
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                            st.setDefaultBufferSize(1280, 720)
                            StreamController.attachPreview(Surface(st))
                        }

                        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}

                        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                            // We release it ourselves once the camera has let go of it.
                            StreamController.detachPreview { st.release() }
                            return false
                        }

                        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
                    }
                }
            },
            modifier = Modifier.align(Alignment.Center).fillMaxWidth().aspectRatio(16f / 9f)
        )

        StatusPill(led, Modifier.align(Alignment.TopStart).padding(12.dp))

        val s = ui.settings
        Text(
            "${s.resolution.label} · ${s.fps} fps · ${if (s.frontCamera) "Front" else "Rear"}",
            color = Studio.TextHi, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            modifier = Modifier.align(Alignment.BottomStart).padding(12.dp)
                .clip(RoundedCornerShape(8.dp)).background(Color(0x99000000))
                .padding(horizontal = 8.dp, vertical = 4.dp)
        )

        if (!ui.cameraPermission) {
            Column(
                Modifier.align(Alignment.Center).clickable(onClick = onAllowCamera).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("Camera access is off", color = Studio.TextHi, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text("Tap to allow the camera", color = Studio.Neon, fontSize = 13.sp)
            }
        }

        ui.error?.let { msg ->
            Text(
                msg, color = Color.White, fontSize = 13.sp,
                modifier = Modifier.align(Alignment.TopEnd).padding(12.dp)
                    .clip(RoundedCornerShape(10.dp)).background(Studio.Danger.copy(alpha = .9f))
                    .clickable { StreamController.clearError() }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            )
        }
    }
}

@Composable
private fun StatusPill(led: Led, modifier: Modifier = Modifier) {
    val glow by rememberInfiniteTransition(label = "led").animateFloat(
        initialValue = 0.25f, targetValue = 0.9f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "glow"
    )
    Row(
        modifier.clip(RoundedCornerShape(50)).background(Color(0xAA000000))
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.size(18.dp).clip(CircleShape).background(led.color.copy(alpha = if (led.pulse) glow * 0.5f else 0.28f)))
            Box(Modifier.size(9.dp).clip(CircleShape).background(led.color))
        }
        Spacer(Modifier.width(8.dp))
        Text(led.text, color = Studio.TextHi, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

// --- side panel ------------------------------------------------------------------------------

@Composable
private fun SidePanel(ui: UiState, onToggle: () -> Unit, modifier: Modifier) {
    Column(modifier) {
        Text("Deenstudio", color = Studio.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text("Phone camera to OBS over USB", color = Studio.TextLo, fontSize = 12.sp)
        Spacer(Modifier.height(10.dp))

        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            MetricsCard(ui)
            ControlsCard(ui)
        }

        Spacer(Modifier.height(10.dp))
        StreamButton(ui.streaming, onToggle)
    }
}

@Composable
private fun Card(title: String, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(Studio.Panel).border(1.dp, Studio.Line, shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(title, color = Studio.TextHi, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        content()
    }
}

@Composable
private fun MetricsCard(ui: UiState) = Card("Connection") {
    val m = ui.metrics
    MetricRow("USB cable", if (ui.usbPlugged) "Connected" else "Not detected", if (ui.usbPlugged) Studio.Live else Studio.Danger)
    MetricRow("USB debugging", if (ui.adbEnabled) "On" else "Off", if (ui.adbEnabled) Studio.Live else Studio.Amber)
    MetricRow(
        "PC viewer",
        if (m.clientConnected) "Connected" else if (ui.streaming) "Waiting" else "Idle",
        if (m.clientConnected) Studio.Live else Studio.TextLo
    )
    MetricRow("Bitrate", "%.1f Mbps".format(m.bitrateKbps / 1000f), Studio.Neon)
    MetricRow("Dropped frames", "${m.droppedFrames}", if (m.droppedFrames > 0) Studio.Amber else Studio.Neon)
    MetricRow("Endpoint", ui.endpoint, Studio.Neon)
}

@Composable
private fun MetricRow(label: String, value: String, valueColor: Color) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Studio.TextLo, fontSize = 12.sp)
        Text(value, color = valueColor, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun ControlsCard(ui: UiState) = Card("Camera") {
    val s = ui.settings

    Label("Lens")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Chip("Rear", !s.frontCamera, modifier = Modifier.weight(1f)) {
            StreamController.update { it.copy(frontCamera = false) }
        }
        Chip("Front", s.frontCamera, modifier = Modifier.weight(1f)) {
            StreamController.update { it.copy(frontCamera = true) }
        }
    }

    Label("Resolution")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Resolution.values().forEach { res ->
            val ok = ui.supported.any { it.first == res }
            Chip(res.label, s.resolution == res, ok, Modifier.weight(1f)) {
                StreamController.update {
                    val keepFps = (res to it.fps) in ui.supported
                    it.copy(resolution = res, fps = if (keepFps) it.fps else 30)
                }
            }
        }
    }

    Label("Frame rate")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(30, 60).forEach { f ->
            val ok = (s.resolution to f) in ui.supported
            Chip("$f fps", s.fps == f, ok, Modifier.weight(1f)) {
                StreamController.update { it.copy(fps = f) }
            }
        }
    }

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Label("Lock focus")
            if (!ui.focusLockAvailable) Text("Fixed-focus lens", color = Studio.TextLo, fontSize = 11.sp)
        }
        Switch(
            checked = s.focusLocked,
            enabled = ui.focusLockAvailable,
            onCheckedChange = { on -> StreamController.update { it.copy(focusLocked = on) } },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Studio.Obsidian, checkedTrackColor = Studio.Neon,
                uncheckedThumbColor = Studio.TextLo, uncheckedTrackColor = Studio.PanelHi,
                uncheckedBorderColor = Studio.Line
            )
        )
    }
    if (s.focusLocked) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Far", color = Studio.TextLo, fontSize = 11.sp)
            NeonSlider(
                value = s.focusPosition, range = 0f..1f, steps = 0,
                onChange = { v -> StreamController.update { it.copy(focusPosition = v) } },
                modifier = Modifier.weight(1f)
            )
            Text("Near", color = Studio.TextLo, fontSize = 11.sp)
        }
    }

    val evText = "%+.1f EV".format(s.exposureComp * ui.evStep)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Label("Exposure")
        Text(evText, color = Studio.Neon, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }
    if (ui.evMax > ui.evMin) {
        NeonSlider(
            value = s.exposureComp.toFloat(),
            range = ui.evMin.toFloat()..ui.evMax.toFloat(),
            steps = ui.evMax - ui.evMin - 1,
            onChange = { v -> StreamController.update { it.copy(exposureComp = v.toInt()) } }
        )
    } else {
        Text("Not adjustable on this camera", color = Studio.TextLo, fontSize = 11.sp)
    }

    Label("White balance")
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        WhiteBalance.values().forEach { wb ->
            Chip(wb.label, s.whiteBalance == wb) {
                StreamController.update { it.copy(whiteBalance = wb) }
            }
        }
    }
}

// --- small building blocks -------------------------------------------------------------------

@Composable
private fun Label(text: String) =
    Text(text, color = Studio.TextLo, fontSize = 12.sp, fontWeight = FontWeight.Medium)

@Composable
private fun Chip(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .clip(shape)
            .background(if (selected) Studio.Neon.copy(alpha = .16f) else Studio.PanelHi)
            .border(1.dp, if (selected) Studio.Neon else Studio.Line, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            label,
            color = when {
                !enabled -> Studio.TextLo.copy(alpha = .4f)
                selected -> Studio.Neon
                else -> Studio.TextHi
            },
            fontSize = 13.sp, fontWeight = FontWeight.Medium
        )
    }
}

@Composable
private fun NeonSlider(
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    steps: Int,
    onChange: (Float) -> Unit,
    modifier: Modifier = Modifier
) {
    Slider(
        value = value.coerceIn(range.start, range.endInclusive),
        onValueChange = onChange,
        valueRange = range,
        steps = steps.coerceAtLeast(0),
        modifier = modifier.fillMaxWidth(),
        colors = SliderDefaults.colors(
            thumbColor = Studio.Neon,
            activeTrackColor = Studio.Neon,
            inactiveTrackColor = Studio.Line,
            activeTickColor = Studio.Obsidian,
            inactiveTickColor = Studio.TextLo
        )
    )
}

@Composable
private fun StreamButton(streaming: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        Modifier.fillMaxWidth().height(52.dp).clip(shape)
            .background(if (streaming) Studio.Danger else Studio.Neon)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Text(
            if (streaming) "Stop stream" else "Start stream",
            color = Studio.Obsidian, fontSize = 16.sp, fontWeight = FontWeight.Bold
        )
    }
}
