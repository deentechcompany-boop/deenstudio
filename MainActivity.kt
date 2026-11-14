package com.deenstudio.app.ui

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.deenstudio.app.core.StreamController

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        StreamController.init(applicationContext)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent { DeenstudioTheme { StudioScreen() } }
    }

    override fun onResume() {
        super.onResume()
        StreamController.refreshEnvironment()
    }
}
