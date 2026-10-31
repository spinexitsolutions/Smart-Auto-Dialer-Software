package com.smartautodialer.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** Notification channels and builders. */
object Notifications {

    const val CHANNEL_SERVICE = "dialer_service"
    const val CHANNEL_ALERTS = "dialer_alerts"
    const val ID_SERVICE = 1001
    const val ID_RETURN_TO_APP = 1002

    private const val RC_OPEN_MAIN = 10
    private const val RC_OPEN_SETTINGS = 11
    private const val RC_RETURN = 12

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SERVICE,
                context.getString(R.string.channel_service),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = context.getString(R.string.channel_service_desc)
                setShowBadge(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ALERTS,
                context.getString(R.string.channel_alerts),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(R.string.channel_alerts_desc)
                setSound(null, null)
                enableVibration(false)
            }
        )
    }

    /** Persistent "Dialer connected" notification for [CallStateService]. */
    fun serviceNotification(context: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_dialer)
            .setContentTitle(context.getString(R.string.notif_connected_title))
            .setContentText(context.getString(R.string.notif_connected_text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(mainActivityIntent(context, RC_OPEN_MAIN))
            .addAction(
                R.drawable.ic_settings,
                context.getString(R.string.notif_action_settings),
                activityIntent(context, Intent(context, SettingsActivity::class.java), RC_OPEN_SETTINGS)
            )
            .build()

    /** Heads-up "Call ended - tap to return" used when we may not start an activity from the background. */
    @SuppressLint("MissingPermission")
    fun showReturnToApp(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !Permissions.has(context, Manifest.permission.POST_NOTIFICATIONS)
        ) return
        val nmc = NotificationManagerCompat.from(context)
        if (!nmc.areNotificationsEnabled()) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_dialer)
            .setContentTitle(context.getString(R.string.notif_call_ended_title))
            .setContentText(context.getString(R.string.notif_call_ended_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setTimeoutAfter(60_000L)
            .setContentIntent(mainActivityIntent(context, RC_RETURN))
            .build()
        try {
            nmc.notify(ID_RETURN_TO_APP, notification)
        } catch (e: SecurityException) {
            // Notification permission revoked meanwhile - nothing else to do.
        }
    }

    fun cancelReturnToApp(context: Context) {
        NotificationManagerCompat.from(context).cancel(ID_RETURN_TO_APP)
    }

    fun mainActivityLaunchIntent(context: Context): Intent =
        Intent(context, MainActivity::class.java).addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        )

    private fun mainActivityIntent(context: Context, requestCode: Int): PendingIntent =
        activityIntent(context, mainActivityLaunchIntent(context), requestCode)

    private fun activityIntent(context: Context, intent: Intent, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
}
