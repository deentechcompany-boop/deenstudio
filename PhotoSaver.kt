package com.deenstudio.app.core

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Saves a JPEG into the gallery (Pictures/Deenstudio). Returns a short description or null. */
object PhotoSaver {
    fun save(ctx: Context, jpeg: ByteArray): String? {
        val name = "Deenstudio_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".jpg"
        return try {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, name)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Deenstudio")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val resolver = ctx.contentResolver
                val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
                resolver.openOutputStream(uri)?.use { it.write(jpeg) } ?: return null
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                "Pictures/Deenstudio"
            } else {
                val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: return null
                dir.mkdirs()
                File(dir, name).writeBytes(jpeg)
                "Android/data/com.deenstudio.app/files/Pictures"
            }
        } catch (e: Exception) {
            null
        }
    }
}
