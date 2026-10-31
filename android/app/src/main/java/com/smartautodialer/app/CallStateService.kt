package com.smartautodialer.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service ("Dialer connected") that keeps the process alive while the agent is
 * on a call and forwards telephony call-state changes to [CallTracker].
 *
 * Uses TelephonyCallback on Android 12+ and PhoneStateListener below.
 * Foreground-service type: `phoneCall` (falls back to `dataSync` if the platform rejects it).
 */
class CallStateService : Service() {

    /** TelephonyCallback on API 31+; typed as Any so the class loads on older devices. */
    private var telephonyCallback: Any? = null

    @Suppress("DEPRECATION")
    private var phoneStateListener: PhoneStateListener? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every startForegroundService() must be answered with startForeground().
        if (!startInForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }
        registerCallStateListener()
        return START_STICKY
    }

    override fun onDestroy() {
        unregisterCallStateListener()
        super.onDestroy()
    }

    private fun startInForeground(): Boolean {
        val notification = Notifications.serviceNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                ServiceCompat.startForeground(
                    this, Notifications.ID_SERVICE, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
                return true
            } catch (e: Exception) {
                Log.w(TAG, "phoneCall FGS type rejected, falling back to dataSync", e)
            }
            return try {
                ServiceCompat.startForeground(
                    this, Notifications.ID_SERVICE, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
                true
            } catch (e: Exception) {
                Log.e(TAG, "Unable to start foreground service", e)
                false
            }
        }
        return try {
            startForeground(Notifications.ID_SERVICE, notification)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Unable to start foreground service", e)
            false
        }
    }

    @SuppressLint("MissingPermission")
    private fun registerCallStateListener() {
        if (telephonyCallback != null || phoneStateListener != null) return
        val tm = getSystemService(TelephonyManager::class.java) ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (!Permissions.has(this, Manifest.permission.READ_PHONE_STATE)) {
                    Log.w(TAG, "READ_PHONE_STATE missing - call state not tracked yet")
                    return
                }
                val callback = CallStateCallback { state -> onCallState(state) }
                tm.registerTelephonyCallback(mainExecutor, callback)
                telephonyCallback = callback
            } else {
                @Suppress("DEPRECATION")
                val listener = object : PhoneStateListener() {
                    @Deprecated("Deprecated in Java")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        onCallState(state)
                    }
                }
                @Suppress("DEPRECATION")
                tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
                phoneStateListener = listener
            }
        } catch (e: Exception) {
            Log.e(TAG, "Unable to register call-state listener", e)
        }
    }

    private fun unregisterCallStateListener() {
        val tm = getSystemService(TelephonyManager::class.java) ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (telephonyCallback as? TelephonyCallback)?.let { tm.unregisterTelephonyCallback(it) }
            } else {
                @Suppress("DEPRECATION")
                phoneStateListener?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unable to unregister call-state listener", e)
        }
        telephonyCallback = null
        phoneStateListener = null
    }

    private fun onCallState(state: Int) {
        Log.d(TAG, "call state -> $state")
        CallTracker.onTelephonyState(this, state)
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private class CallStateCallback(
        private val onState: (Int) -> Unit,
    ) : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) = onState(state)
    }

    companion object {
        private const val TAG = "CallStateService"

        /**
         * Starts the service (or re-checks listener registration if already running).
         * Must be called while the app is in the foreground (Android 12+ FGS restrictions).
         */
        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(
                    context, Intent(context, CallStateService::class.java)
                )
            } catch (e: Exception) {
                // e.g. ForegroundServiceStartNotAllowedException when started from background.
                Log.w(TAG, "Unable to start CallStateService", e)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallStateService::class.java))
        }
    }
}
