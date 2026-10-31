package com.smartautodialer.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telecom.TelecomManager
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * JavaScript interface exposed to the web panel as `window.AndroidDialer`.
 *
 * Methods are invoked on a WebView background thread ("JavaBridge"); anything touching
 * UI or [CallTracker] is posted to the main thread. Getters return synchronously.
 *
 * Call-state events flow the other way: native -> `window.SADNative.onCallState(jsonString)`.
 */
class DialerBridge(activity: MainActivity) {

    private val activityRef = WeakReference(activity)
    private val app: Context = activity.applicationContext
    private val prefs = Prefs.get(app)
    private val main = Handler(Looper.getMainLooper())

    // ---------------------------------------------------------------- contract methods

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun getSims(): String = SimHelper.getSimsJson(app)

    @JavascriptInterface
    fun getDeviceInfo(): String = JSONObject()
        .put("model", Build.MODEL)
        .put("manufacturer", Build.MANUFACTURER)
        .put("brand", Build.BRAND)
        .put("android", Build.VERSION.RELEASE)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put("appVersionCode", BuildConfig.VERSION_CODE)
        .put("applicationId", BuildConfig.APPLICATION_ID)
        .toString()

    @JavascriptInterface
    fun setAuthToken(token: String?) {
        prefs.authToken = token?.trim().orEmpty()
    }

    /**
     * Places a real SIM call. `simSlot` is 0-based; pass -1 for the phone's default SIM.
     * Emits "dialing" immediately; failures are reported as "ended" with an `error` field.
     * @return false if the request was rejected synchronously (empty number).
     */
    @JavascriptInterface
    fun dial(callId: String?, phone: String?, simSlot: Int): Boolean {
        val id = callId?.trim().orEmpty().ifEmpty { "local-${System.currentTimeMillis()}" }
        val number = PhoneUtils.sanitizeForDial(phone)
        if (number.isEmpty()) {
            CallTracker.reportImmediateFailure(id, phone.orEmpty(), simSlot, CallPlacer.ERROR_INVALID_NUMBER)
            return false
        }
        main.post { placeCall(id, number, simSlot) }
        return true
    }

    /** Hangs up the active call (Android 9+ with ANSWER_PHONE_CALLS); otherwise returns false. */
    @JavascriptInterface
    fun endCall(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        if (!Permissions.has(app, Manifest.permission.ANSWER_PHONE_CALLS)) return false
        return try {
            val telecom = app.getSystemService(TelecomManager::class.java) ?: return false
            endCallCompat(telecom)
        } catch (e: Exception) {
            Log.w(TAG, "endCall failed", e)
            false
        }
    }

    @JavascriptInterface
    fun openWhatsApp(phone: String?, text: String?) {
        val digits = PhoneUtils.digits(phone)
        val url = buildString {
            append("https://wa.me/").append(digits)
            if (!text.isNullOrEmpty()) append("?text=").append(Uri.encode(text))
        }
        startExternal(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    @JavascriptInterface
    fun sendSms(phone: String?, text: String?) {
        val number = PhoneUtils.sanitizeForDial(phone)
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)))
            .putExtra("sms_body", text.orEmpty())
        startExternal(intent)
    }

    @JavascriptInterface
    fun setAutoReturn(enabled: Boolean) {
        prefs.autoReturn = enabled
    }

    // ---------------------------------------------------------------- extras (optional for the web)

    /** Re-delivers queued call events; call right after defining `window.SADNative`. */
    @JavascriptInterface
    fun flushEvents() = CallEventBus.flush()

    /** The call being tracked (same shape as an onCallState event) or `null`. */
    @JavascriptInterface
    fun getCurrentCall(): String {
        // Prefs reads are thread-safe; build on this thread.
        return CallTracker.currentCallJson(app)
    }

    /** `{"CALL_PHONE":true,"READ_CALL_LOG":false,...}` */
    @JavascriptInterface
    fun getPermissions(): String = Permissions.statusJson(app)

    /** Shows the system permission prompt for any missing runtime permissions. */
    @JavascriptInterface
    fun requestPermissions() {
        main.post { activityRef.get()?.requestMissingPermissions() }
    }

    /** Opens the native settings screen (server URL, auto-return, recordings...). */
    @JavascriptInterface
    fun openSettings() {
        main.post { activityRef.get()?.openSettings() }
    }

    @JavascriptInterface
    fun setKeepScreenOn(enabled: Boolean) {
        prefs.keepScreenOn = enabled
        main.post { activityRef.get()?.applyKeepScreenOn() }
    }

    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getServerUrl(): String = prefs.serverUrl

    @JavascriptInterface
    fun isRecordingUploadEnabled(): Boolean = prefs.recordingUploadEnabled

    // ---------------------------------------------------------------- internals

    // TelecomManager.endCall() is deprecated since API 29 but remains the only public
    // way for a non-default-dialer app to hang up; it still works on Android 14.
    @RequiresApi(Build.VERSION_CODES.P)
    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun endCallCompat(telecom: TelecomManager): Boolean = telecom.endCall()

    private fun placeCall(callId: String, number: String, simSlot: Int) {
        val activity = activityRef.get()
        if (!Permissions.has(app, Manifest.permission.CALL_PHONE)) {
            CallTracker.reportImmediateFailure(callId, number, simSlot, CallPlacer.ERROR_PERMISSION)
            activity?.requestMissingPermissions()
            return
        }
        // Make sure call-state tracking is running before the in-call UI takes over.
        CallStateService.start(app)
        CallTracker.onDialRequested(app, callId, number, simSlot)
        val error = CallPlacer.place(activity ?: app, number, simSlot)
        if (error != null) {
            CallTracker.onDialFailed(app, callId, error)
        }
    }

    private fun startExternal(intent: Intent) {
        main.post {
            val ctx: Context = activityRef.get() ?: app
            if (ctx === app) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                ctx.startActivity(intent)
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(app, R.string.error_no_app, Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Log.w(TAG, "Unable to start external activity", e)
            }
        }
    }

    companion object {
        const val JS_NAME = "AndroidDialer"
        private const val TAG = "DialerBridge"
    }
}
