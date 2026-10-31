package com.smartautodialer.app

import android.app.Application
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

class DialerApp : Application() {

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        publishShortcuts(this)
    }

    /** Long-press the launcher icon -> "Dialer settings" (always reachable, even if the panel fails). */
    private fun publishShortcuts(context: Context) {
        try {
            val settings = ShortcutInfoCompat.Builder(context, "settings")
                .setShortLabel(context.getString(R.string.shortcut_settings))
                .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_settings))
                .setIntent(Intent(context, SettingsActivity::class.java).setAction(Intent.ACTION_VIEW))
                .build()
            ShortcutManagerCompat.setDynamicShortcuts(context, listOf(settings))
        } catch (e: Exception) {
            Log.w("DialerApp", "Unable to publish shortcuts", e)
        }
    }
}
