package com.smartautodialer.app

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.BaseColumns
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.RequiresApi
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/** A call-recording candidate found on the device. */
data class RecordingFile(
    val name: String,
    val sizeBytes: Long,
    val modifiedMs: Long,
    val uri: Uri? = null,
    val file: File? = null,
) {
    fun open(context: Context): InputStream? = when {
        file != null -> FileInputStream(file)
        uri != null -> context.contentResolver.openInputStream(uri)
        else -> null
    }
}

/**
 * Locates the audio file the phone's built-in call recorder wrote for a given call.
 *
 * Strategy: list audio files in the configured folder (MediaStore on Android 10+, plus a
 * direct File-API scan as fallback since MediaStore indexing can lag), keep those modified
 * within the call window, prefer a file whose name contains the dialed number, else newest.
 */
object RecordingFinder {

    private const val TAG = "RecordingFinder"

    const val DEFAULT_FOLDER = "Recordings/Call"

    val AUDIO_EXTENSIONS = setOf("mp3", "m4a", "amr", "wav", "aac", "ogg", "opus", "3gp", "3ga", "awb")

    /** Common call-recording folders by manufacturer (relative to internal storage). */
    val PRESETS = listOf(
        "Recordings/Call",                 // Samsung (One UI 4+), many Android 12+ OEM dialers
        "Call",                            // Older Samsung
        "MIUI/sound_recorder/call_rec",    // Xiaomi / Redmi / POCO (MIUI)
        "Recordings/Call Recordings",      // Realme / OPPO (ColorOS), OnePlus 9+
        "Music/Recordings/Call Recordings",// Realme / OPPO (older)
        "Record/PhoneRecord",              // OnePlus (OxygenOS, older), Vivo (older)
        "Recordings/Record/Call",          // Vivo (Funtouch / OriginOS)
        "Sounds/CallRecord",               // Huawei / Honor (EMUI)
        "Recordings",                      // Generic
        "CallRecordings",                  // Third-party recorders
    )

    /**
     * @param fromMs earliest acceptable modification time (typically the dial time).
     * @param toMs latest acceptable modification time (call end + grace period).
     */
    fun find(context: Context, folder: String, fromMs: Long, toMs: Long, phone: String): RecordingFile? {
        val relative = relativePath(folder)
        if (relative.isEmpty()) {
            Log.w(TAG, "Recording folder not configured")
            return null
        }
        val candidates = ArrayList<RecordingFile>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            candidates += queryMediaStore(context, relative, fromMs, toMs)
        }
        candidates += scanDirectory(relative, fromMs, toMs)
        if (candidates.isEmpty()) return null

        val tail = PhoneUtils.digits(phone).takeLast(7)
        val byNumber = if (tail.length == 7) {
            candidates.filter { PhoneUtils.digits(it.name).contains(tail) }
        } else {
            emptyList()
        }
        return byNumber.ifEmpty { candidates }.maxByOrNull { it.modifiedMs }
    }

    /** "/storage/emulated/0/Recordings/Call/" or "/Recordings/Call" -> "Recordings/Call/". */
    fun relativePath(folder: String): String {
        var f = folder.trim().replace('\\', '/')
        val root = externalRoot().absolutePath
        f = when {
            f.startsWith(root) -> f.removePrefix(root)
            f.startsWith("/sdcard") -> f.removePrefix("/sdcard")
            else -> f
        }
        f = f.trim('/')
        return if (f.isEmpty()) "" else "$f/"
    }

    @Suppress("DEPRECATION")
    private fun externalRoot(): File = Environment.getExternalStorageDirectory()

    private fun isAudioName(name: String): Boolean =
        name.substringAfterLast('.', "").lowercase() in AUDIO_EXTENSIONS

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun queryMediaStore(context: Context, relative: String, fromMs: Long, toMs: Long): List<RecordingFile> {
        val out = ArrayList<RecordingFile>()
        val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
        val projection = arrayOf(
            BaseColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
        )
        val selection = "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ? AND " +
            "${MediaStore.MediaColumns.DATE_MODIFIED} >= ? AND ${MediaStore.MediaColumns.DATE_MODIFIED} <= ?"
        // DATE_MODIFIED is in seconds.
        val args = arrayOf("$relative%", (fromMs / 1000 - 1).toString(), (toMs / 1000 + 1).toString())
        try {
            context.contentResolver.query(collection, projection, selection, args, null)?.use { c ->
                val iId = c.getColumnIndexOrThrow(BaseColumns._ID)
                val iName = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val iSize = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val iModified = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                while (c.moveToNext()) {
                    val name = c.getString(iName) ?: continue
                    if (!isAudioName(name)) continue
                    val size = c.getLong(iSize)
                    if (size <= 0) continue
                    out += RecordingFile(
                        name = name,
                        sizeBytes = size,
                        modifiedMs = c.getLong(iModified) * 1000,
                        uri = ContentUris.withAppendedId(collection, c.getLong(iId)),
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "MediaStore query failed", e)
        }
        return out
    }

    private fun scanDirectory(relative: String, fromMs: Long, toMs: Long): List<RecordingFile> {
        return try {
            val dir = File(externalRoot(), relative)
            if (!dir.isDirectory) return emptyList()
            dir.walkTopDown()
                .maxDepth(3)
                .filter { it.isFile && isAudioName(it.name) }
                .filter { it.lastModified() in (fromMs - 1000)..(toMs + 1000) && it.length() > 0 }
                .map { RecordingFile(name = it.name, sizeBytes = it.length(), modifiedMs = it.lastModified(), file = it) }
                .toList()
        } catch (e: Exception) {
            Log.w(TAG, "Directory scan failed", e)
            emptyList()
        }
    }
}
