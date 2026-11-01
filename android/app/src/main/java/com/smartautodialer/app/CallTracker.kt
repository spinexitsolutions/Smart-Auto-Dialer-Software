package com.smartautodialer.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * State machine for the call placed via `AndroidDialer.dial()`.
 *
 *   dial()            -> "dialing"
 *   OFFHOOK           -> "offhook"
 *   IDLE (after 1.5s) -> call-log lookup -> "ended" {durationSec, connected}
 *
 * Every transition is pushed to the web panel through [CallEventBus]. The active call is
 * persisted in [Prefs] so a process restart while a call is in progress can still finish it.
 * All public methods must be called on the main thread.
 */
object CallTracker {

    private const val TAG = "CallTracker"

    const val STATE_DIALING = "dialing"
    const val STATE_OFFHOOK = "offhook"
    const val STATE_ENDED = "ended"
    /** Internal: IDLE observed, call-log lookup pending. Never sent to the web. */
    private const val STATE_ENDING = "ending"

    const val ERROR_SUPERSEDED = "superseded"
    const val ERROR_NOT_STARTED = "call_not_started"

    private const val END_QUERY_DELAY_MS = 1_500L
    private const val CALL_LOG_RETRY_DELAY_MS = 1_500L
    private const val CALL_LOG_ATTEMPTS = 3
    /** If the phone never goes OFFHOOK within this time, the dial attempt is considered failed. */
    private const val DIAL_TIMEOUT_MS = 60_000L
    /** Tolerance for clock skew between our timestamp and the call-log DATE column. */
    private const val CALL_LOG_SKEW_MS = 5_000L

    private val main = Handler(Looper.getMainLooper())
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()

    private var dialWatchdog: Runnable? = null
    private var finalizingToken: String? = null
    private val finishedTokens = LinkedHashSet<String>()

    /** JSON of the call currently tracked, or `null`. */
    fun currentCallJson(context: Context): String {
        val call = Prefs.get(context).activeCall ?: return "null"
        return buildEvent(call, publicState(call.state), endedAt = null, durationSec = 0, connected = false)
    }

    fun onDialRequested(context: Context, callId: String, phone: String, simSlot: Int) {
        val app = context.applicationContext
        val prefs = Prefs.get(app)

        prefs.activeCall?.let { supersede(app, it) }
        cancelWatchdog()

        val call = ActiveCall(callId = callId, phone = phone, simSlot = simSlot, dialAt = System.currentTimeMillis())
        prefs.activeCall = call
        Notifications.cancelReturnToApp(app)
        emit(buildEvent(call, STATE_DIALING, endedAt = null, durationSec = 0, connected = false))
        scheduleWatchdog(app, call)
    }

    /** The dial intent could not be started; close the attempt immediately. */
    fun onDialFailed(context: Context, callId: String, error: String) {
        val app = context.applicationContext
        val call = Prefs.get(app).activeCall?.takeIf { it.callId == callId } ?: return
        cancelWatchdog()
        finish(app, call, System.currentTimeMillis(), entry = null, error = error, allowAutoReturn = false)
    }

    /** Reports a failure for a call that never became active (e.g. permission missing). */
    fun reportImmediateFailure(callId: String, phone: String, simSlot: Int, error: String) {
        val now = System.currentTimeMillis()
        val call = ActiveCall(callId, phone, simSlot, dialAt = now)
        emit(buildEvent(call, STATE_ENDED, endedAt = now, durationSec = 0, connected = false, error = error))
    }

    /**
     * Fed by [CallStateService] with TelephonyManager.CALL_STATE_* values (before
     * [IncomingCallTracker] sees the same state).
     */
    fun onTelephonyState(context: Context, state: Int) {
        val app = context.applicationContext
        val prefs = Prefs.get(app)
        val call = prefs.activeCall ?: return

        when (state) {
            // OFFHOOK while an incoming call rings = the agent answered that call, not our
            // dialed call connecting; keep waiting (the dial watchdog still applies).
            TelephonyManager.CALL_STATE_OFFHOOK -> if (call.state == STATE_DIALING &&
                !IncomingCallTracker.hasRingingCall(app)
            ) {
                cancelWatchdog()
                val updated = call.copy(state = STATE_OFFHOOK, offhookAt = System.currentTimeMillis())
                prefs.activeCall = updated
                emit(buildEvent(updated, STATE_OFFHOOK, endedAt = null, durationSec = 0, connected = false))
            }

            TelephonyManager.CALL_STATE_IDLE -> when (call.state) {
                STATE_OFFHOOK -> {
                    val ending = call.copy(state = STATE_ENDING, endedAt = System.currentTimeMillis())
                    prefs.activeCall = ending
                    startFinalize(app, ending)
                }
                // Process was restarted while a lookup was pending.
                STATE_ENDING -> startFinalize(app, call)
            }

            // RINGING = incoming (or call-waiting) call; handled by IncomingCallTracker.
            else -> Unit
        }
    }

    // ------------------------------------------------------------------------------------

    private fun supersede(app: Context, previous: ActiveCall) {
        if (previous.state == STATE_ENDING) {
            // Let the pending lookup finish on its own (restart it if the process died).
            startFinalize(app, previous)
            return
        }
        finish(app, previous, System.currentTimeMillis(), entry = null, error = ERROR_SUPERSEDED, allowAutoReturn = false)
    }

    private fun startFinalize(app: Context, call: ActiveCall) {
        if (finalizingToken == call.token || call.token in finishedTokens) return
        finalizingToken = call.token
        main.postDelayed({ worker.execute { lookupDuration(app, call, attempt = 1) } }, END_QUERY_DELAY_MS)
    }

    /** Runs on [worker]. The call log is sometimes written a moment after IDLE, so retry a few times. */
    private fun lookupDuration(app: Context, call: ActiveCall, attempt: Int) {
        val entry = CallLogHelper.findOutgoingCall(app, call.phone, call.dialAt - CALL_LOG_SKEW_MS)
        if (entry == null && attempt < CALL_LOG_ATTEMPTS && CallLogHelper.canRead(app)) {
            main.postDelayed(
                { worker.execute { lookupDuration(app, call, attempt + 1) } },
                CALL_LOG_RETRY_DELAY_MS
            )
            return
        }
        main.post {
            if (finalizingToken == call.token) finalizingToken = null
            finish(app, call, call.endedAt.takeIf { it > 0 } ?: System.currentTimeMillis(), entry, error = null, allowAutoReturn = true)
        }
    }

    private fun finish(
        app: Context,
        call: ActiveCall,
        endedAt: Long,
        entry: CallLogHelper.Entry?,
        error: String?,
        allowAutoReturn: Boolean,
    ) {
        if (!markFinished(call.token)) return
        val prefs = Prefs.get(app)
        if (prefs.activeCall?.token == call.token) prefs.activeCall = null

        val durationSec = entry?.durationSec ?: 0L
        val connected = durationSec > 0
        val callLogFound = entry != null
        val offhookSec = if (call.offhookAt > 0) ((endedAt - call.offhookAt) / 1000).coerceAtLeast(0) else 0L

        emit(
            buildEvent(
                call, STATE_ENDED,
                endedAt = endedAt,
                durationSec = durationSec,
                connected = connected,
                error = error ?: if (call.offhookAt == 0L) ERROR_NOT_STARTED else null,
                callLogFound = callLogFound,
                offhookSec = offhookSec,
            )
        )

        if (connected) {
            RecordingUploader.enqueue(app, call.callId, call.phone, call.dialAt, endedAt)
        }
        // Only bring the panel back if no newer call has started meanwhile.
        if (allowAutoReturn && prefs.autoReturn && prefs.activeCall == null) {
            bringAppToFront(app)
        }
    }

    private fun markFinished(token: String): Boolean {
        if (!finishedTokens.add(token)) return false
        while (finishedTokens.size > 50) finishedTokens.remove(finishedTokens.first())
        return true
    }

    private fun scheduleWatchdog(app: Context, call: ActiveCall) {
        val r = Runnable {
            dialWatchdog = null
            val current = Prefs.get(app).activeCall
            if (current != null && current.token == call.token && current.state == STATE_DIALING) {
                Log.i(TAG, "No OFFHOOK within timeout for ${call.callId}")
                finish(app, current, System.currentTimeMillis(), entry = null, error = ERROR_NOT_STARTED, allowAutoReturn = false)
            }
        }
        dialWatchdog = r
        main.postDelayed(r, DIAL_TIMEOUT_MS)
    }

    private fun cancelWatchdog() {
        dialWatchdog?.let { main.removeCallbacks(it) }
        dialWatchdog = null
    }

    /**
     * Android 10+ blocks activity starts from the background unless the app holds
     * "Display over other apps". Without it we fall back to a tap-to-return notification.
     */
    private fun bringAppToFront(app: Context) {
        val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Settings.canDrawOverlays(app)
        try {
            app.startActivity(Notifications.mainActivityLaunchIntent(app))
        } catch (e: Exception) {
            Log.w(TAG, "Could not bring app to front", e)
        }
        if (!allowed) Notifications.showReturnToApp(app)
    }

    private fun publicState(state: String): String = if (state == STATE_ENDING) STATE_OFFHOOK else state

    private fun emit(json: String) = CallEventBus.emit(json)

    private fun buildEvent(
        call: ActiveCall,
        state: String,
        endedAt: Long?,
        durationSec: Long,
        connected: Boolean,
        error: String? = null,
        callLogFound: Boolean? = null,
        offhookSec: Long? = null,
    ): String {
        val o = JSONObject()
            .put("callId", call.callId)
            .put("phone", call.phone)
            .put("state", state)
            .put("durationSec", durationSec)
            .put("connected", connected)
            .put("startedAt", call.dialAt)
            .put("endedAt", endedAt ?: JSONObject.NULL)
            .put("simSlot", call.simSlot)
        if (call.offhookAt > 0) o.put("offhookAt", call.offhookAt)
        if (error != null) o.put("error", error)
        if (callLogFound != null) o.put("callLogFound", callLogFound)
        if (offhookSec != null) o.put("offhookSec", offhookSec)
        return o.toString()
    }
}
