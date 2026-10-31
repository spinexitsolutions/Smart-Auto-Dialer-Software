package com.smartautodialer.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** Central list of runtime permissions the app asks for, with user-facing explanations. */
object Permissions {

    data class Item(
        val permission: String,
        @StringRes val title: Int,
        @StringRes val reason: Int,
        /** Required for the core dialing workflow. */
        val required: Boolean,
    )

    /** Runtime permissions relevant on this device's Android version. */
    fun items(): List<Item> = buildList {
        add(Item(Manifest.permission.CALL_PHONE, R.string.perm_call_phone, R.string.perm_call_phone_reason, true))
        add(Item(Manifest.permission.READ_PHONE_STATE, R.string.perm_phone_state, R.string.perm_phone_state_reason, true))
        add(Item(Manifest.permission.READ_CALL_LOG, R.string.perm_call_log, R.string.perm_call_log_reason, true))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            add(Item(Manifest.permission.READ_PHONE_NUMBERS, R.string.perm_phone_numbers, R.string.perm_phone_numbers_reason, false))
            add(Item(Manifest.permission.ANSWER_PHONE_CALLS, R.string.perm_answer_calls, R.string.perm_answer_calls_reason, false))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Item(Manifest.permission.POST_NOTIFICATIONS, R.string.perm_notifications, R.string.perm_notifications_reason, false))
        }
        add(Item(audioReadPermission(), R.string.perm_audio_files, R.string.perm_audio_files_reason, false))
        add(Item(Manifest.permission.RECORD_AUDIO, R.string.perm_microphone, R.string.perm_microphone_reason, false))
    }

    /** Permission needed to read audio files written by other apps (call recorder). */
    fun audioReadPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO
        else Manifest.permission.READ_EXTERNAL_STORAGE

    fun has(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun missing(context: Context): List<Item> = items().filterNot { has(context, it.permission) }

    fun missingRequired(context: Context): List<Item> = missing(context).filter { it.required }

    /** `{"CALL_PHONE":true, ...}` for the web panel. */
    fun statusJson(context: Context): String {
        val o = JSONObject()
        items().forEach { o.put(it.permission.substringAfterLast('.'), has(context, it.permission)) }
        o.put("SYSTEM_ALERT_WINDOW", Settings.canDrawOverlays(context))
        return o.toString()
    }

    fun appSettingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
