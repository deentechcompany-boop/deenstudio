package com.deenstudio.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Obsidian base, one electric-cyan accent, and a traffic-light trio for the status LED. */
object Studio {
    val Obsidian = Color(0xFF0A0C10)
    val Panel = Color(0xFF11151C)
    val PanelHi = Color(0xFF1A2029)
    val Line = Color(0xFF262E3B)
    val Neon = Color(0xFF35E0FF)
    val Live = Color(0xFF2BFF88)
    val Amber = Color(0xFFFFB020)
    val Danger = Color(0xFFFF3D6E)
    val TextHi = Color(0xFFE8ECF2)
    val TextLo = Color(0xFF7C8798)
}

@Composable
fun DeenstudioTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Studio.Neon,
            background = Studio.Obsidian,
            surface = Studio.Panel,
            onSurface = Studio.TextHi,
            onBackground = Studio.TextHi
        ),
        content = content
    )
}
