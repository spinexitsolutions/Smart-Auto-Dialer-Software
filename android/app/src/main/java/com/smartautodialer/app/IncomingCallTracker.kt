package com.smartautodialer.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Whether the panel (MainActivity) is currently resumed; written on the main thread. */
object AppVisibility {
    @Volatile
    var mainActivityResumed: Boolean = false
}

/**
 * Tracks calls the agent RECEIVES on the phone (independently of [CallTracker], which only
 * tracks calls placed through `AndroidDialer.dial()`).
 *
 *   RINGING                -> "ringing"  (phone may be "" on Android 10+/12+)
 *   OFFHOOK while ringing  -> "answered"
 *   IDLE (after 1.5 s)     -> call-log lookup (INCOMING / MISSED / REJECTED / BLOCKED) -> "ended"
 *
 * Call waiting (RINGING while another call is already off-hook): "ringing" is reported as usual.
 * The following OFFHOOK is ambiguous (answered + other call held, or declined), so the call log
 * is checked for a missed/rejected row first; if there is one the call ends right away as missed,
 * otherwise it is reported "answered" and ends with the final IDLE.
 *
 * Events go to `window.SADNative.onIncomingCall(jsonString)` through [CallEventBus].
 * Active calls are persisted in [Prefs] so tracking survives a process restart.
 * All public methods must be called on the main thread.
 */
object IncomingCallTracker {

    private const val TAG = "IncomingCallTracker"

    const val STATE_RINGING = "ringing"
    const val STATE_ANSWERED = "answered"
    const val STATE_ENDED = "ended"
    /** Internal: call-waiting call, OFFHOOK seen, checking the call log for a decline. Public: "ringing". */
    private const val STATE_RESOLVING = "resolving"
    /** Internal: IDLE observed, call-log lookup pending. Public: last public state. */
    private const val STATE_ENDING = "ending"

    private const val END_QUERY_DELAY_MS = 1_500L
    private const val CALL_LOG_RETRY_DELAY_MS = 1_500L
    private const val CALL_LOG_ATTEMPTS = 3
    /** Tolerance for clock skew / logging delay between RINGING and the call-log DATE column. */
    private const val CALL_LOG_SKEW_MS = 5_000L
    /**
     * Defensive: a RINGING this soon after an app-initiated dial, with no number or the dialed
     * number, is assumed to be a quirky ROM reporting the outgoing call and is ignored.
     */
    private const val OUTGOING_GRACE_MS = 3_000L

    private val main = Handler(Looper.getMainLooper())
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()

    /** Call ids with a pending end lookup (main thread). */
    private val finalizing = HashSet<String>()
    /** Call ids that already emitted "ended" (main thread). */
    private val finished = LinkedHashSet<String>()
    /** Call-log rows already attributed to a call (worker thread only). */
    private val usedRowIds = LinkedHashSet<Long>()

    /** The incoming call currently ringing / in progress (same shape as an event), or `null`. */
    fun currentCallJson(context: Context): String {
        val call = Prefs.get(context).activeIncoming.lastOrNull() ?: return "null"
        return buildEvent(call, publicState(call), endedAt = null)
    }

    /** True while a received call is ringing (not yet answered / declined). */
    fun hasRingingCall(context: Context): Boolean =
        Prefs.get(context).activeIncoming.any { it.state == STATE_RINGING }

    /**
     * Fed by [CallStateService] with TelephonyManager.CALL_STATE_* values.
     * @param prevState the previous call state (-1 if unknown).
     * @param number incoming number if the platform provided it (PhoneStateListener + READ_CALL_LOG).
     */
    fun onTelephonyState(context: Context, state: Int, prevState: Int, number: String?) {
        val app = context.applicationContext
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> onRinging(app, prevState, number?.trim().orEmpty())
            TelephonyManager.CALL_STATE_OFFHOOK -> onOffhook(app)
            TelephonyManager.CALL_STATE_IDLE -> onIdle(app)
        }
    }

    // ------------------------------------------------------------------------------------

    private fun onRinging(app: Context, prevState: Int, number: String) {
        val prefs = Prefs.get(app)
        val calls = prefs.activeIncoming.toMutableList()
        val now = System.currentTimeMillis()

        // Repeated RINGING for the same call (e.g. first without, then with the number).
        val idx = calls.indexOfFirst { it.state == STATE_RINGING }
        if (idx >= 0) {
            val call = calls[idx]
            if (call.phone.isEmpty() && number.isNotEmpty()) {
                val updated = call.copy(phone = number)
                calls[idx] = updated
                prefs.activeIncoming = calls
                emit(buildEvent(updated, STATE_RINGING, endedAt = null))
                if (!AppVisibility.mainActivityResumed) Notifications.showIncomingCall(app, number)
            }
            return
        }

        if (!prefs.incomingTracking) return

        val outgoing = prefs.activeCall
        if (outgoing != null && outgoing.state == CallTracker.STATE_DIALING &&
            (now - outgoing.dialAt) in 0L until OUTGOING_GRACE_MS &&
            (number.isEmpty() || PhoneUtils.sameNumber(number, outgoing.phone))
        ) {
            Log.i(TAG, "RINGING right after dial() of ${outgoing.callId}; not treated as incoming")
            return
        }

        val waiting = prevState == TelephonyManager.CALL_STATE_OFFHOOK ||
            calls.any { it.state == STATE_ANSWERED || it.state == STATE_RESOLVING } ||
            outgoing?.state == CallTracker.STATE_OFFHOOK
        var idMs = now
        while (calls.any { it.id == "in-$idMs" } || "in-$idMs" in finished) idMs++
        val id = "in-$idMs"
        val call = IncomingCall(id = id, phone = number, startedAt = now, waiting = waiting)
        calls.add(call)
        prefs.activeIncoming = calls
        emit(buildEvent(call, STATE_RINGING, endedAt = null))
        if (!AppVisibility.mainActivityResumed) Notifications.showIncomingCall(app, number)
    }

    private fun onOffhook(app: Context) {
        val prefs = Prefs.get(app)
        val calls = prefs.activeIncoming.toMutableList()
        val idx = calls.indexOfFirst { it.state == STATE_RINGING }
        if (idx < 0) return
        val call = calls[idx]
        val now = System.currentTimeMillis()

        if (!call.waiting) {
            val answered = call.copy(state = STATE_ANSWERED, answeredAt = now)
            calls[idx] = answered
            prefs.activeIncoming = calls
            emit(buildEvent(answered, STATE_ANSWERED, endedAt = null))
            return
        }

        // Call waiting: answered (other call on hold) or declined? Ask the call log.
        val resolving = call.copy(state = STATE_RESOLVING, answeredAt = now)
        calls[idx] = resolving
        prefs.activeIncoming = calls
        main.postDelayed({ worker.execute { resolveWaiting(app, resolving, attempt = 1) } }, END_QUERY_DELAY_MS)
    }

    private fun onIdle(app: Context) {
        Notifications.cancelIncomingCall(app)
        val prefs = Prefs.get(app)
        val calls = prefs.activeIncoming
        if (calls.isEmpty()) return
        val now = System.currentTimeMillis()
        val ending = calls.map {
            if (it.state == STATE_ENDING) it
            else it.copy(state = STATE_ENDING, endedAt = it.endedAt.takeIf { t -> t > 0 } ?: now)
        }
        prefs.activeIncoming = ending
        ending.forEach { startFinalize(app, it) }
    }

    /** Runs on [worker]. */
    private fun resolveWaiting(app: Context, call: IncomingCall, attempt: Int) {
        val entry = CallLogHelper.findIncomingCall(
            app, call.phone, call.startedAt - CALL_LOG_SKEW_MS, usedRowIds, rejectOnly = true
        )
        if (entry == null && attempt < CALL_LOG_ATTEMPTS && CallLogHelper.canRead(app)) {
            main.postDelayed({ worker.execute { resolveWaiting(app, call, attempt + 1) } }, CALL_LOG_RETRY_DELAY_MS)
            return
        }
        if (entry != null) {
            markRowUsed(entry.rowId)
            val slot = SimHelper.slotForPhoneAccountId(app, entry.phoneAccountId)
            main.post {
                // Declined / missed while the other call continued: it is over already.
                val endedAt = call.answeredAt.takeIf { it > 0 } ?: System.currentTimeMillis()
                finish(app, call.copy(answeredAt = 0L, endedAt = endedAt), entry, slot)
            }
            return
        }
        main.post {
            val prefs = Prefs.get(app)
            val calls = prefs.activeIncoming.toMutableList()
            val idx = calls.indexOfFirst { it.id == call.id && it.state == STATE_RESOLVING }
            if (idx < 0) return@post // ended meanwhile; the IDLE lookup decides.
            val answered = calls[idx].copy(state = STATE_ANSWERED)
            calls[idx] = answered
            prefs.activeIncoming = calls
            emit(buildEvent(answered, STATE_ANSWERED, endedAt = null))
        }
    }

    private fun startFinalize(app: Context, call: IncomingCall) {
        if (call.id in finalizing || call.id in finished) return
        finalizing.add(call.id)
        main.postDelayed({ worker.execute { lookupEnd(app, call, attempt = 1) } }, END_QUERY_DELAY_MS)
    }

    /** Runs on [worker]. The call log is sometimes written a moment after IDLE, so retry a few times. */
    private fun lookupEnd(app: Context, call: IncomingCall, attempt: Int) {
        val entry = CallLogHelper.findIncomingCall(app, call.phone, call.startedAt - CALL_LOG_SKEW_MS, usedRowIds)
        if (entry == null && attempt < CALL_LOG_ATTEMPTS && CallLogHelper.canRead(app)) {
            main.postDelayed({ worker.execute { lookupEnd(app, call, attempt + 1) } }, CALL_LOG_RETRY_DELAY_MS)
            return
        }
        if (entry != null) markRowUsed(entry.rowId)
        val slot = entry?.let { SimHelper.slotForPhoneAccountId(app, it.phoneAccountId) } ?: -1
        main.post {
            finalizing.remove(call.id)
            finish(app, call, entry, slot)
        }
    }

    private fun finish(app: Context, call: IncomingCall, entry: CallLogHelper.IncomingEntry?, simSlot: Int) {
        if (!markFinished(call.id)) return
        val prefs = Prefs.get(app)
        val remaining = prefs.activeIncoming.filterNot { it.id == call.id }
        prefs.activeIncoming = remaining
        if (remaining.none { it.state == STATE_RINGING }) Notifications.cancelIncomingCall(app)

        val endedAt = call.endedAt.takeIf { it > 0 } ?: System.currentTimeMillis()
        val answered: Boolean
        val durationSec: Long
        if (entry != null) {
            answered = entry.type == CallLog.Calls.INCOMING_TYPE && entry.durationSec > 0
            durationSec = entry.durationSec
        } else {
            // No call-log access / row not written: best effort from the observed states.
            answered = call.answeredAt > 0
            durationSec = if (answered) ((endedAt - call.answeredAt) / 1000).coerceAtLeast(0L) else 0L
        }
        val phone = call.phone.ifEmpty { entry?.number.orEmpty() }

        emit(
            buildEvent(
                call.copy(phone = phone), STATE_ENDED,
                endedAt = endedAt,
                answered = answered,
                durationSec = durationSec,
                simSlot = simSlot,
                callLogType = entry?.type,
            )
        )
    }

    private fun markFinished(id: String): Boolean {
        if (!finished.add(id)) return false
        while (finished.size > 50) finished.remove(finished.first())
        return true
    }

    /** Worker thread only. */
    private fun markRowUsed(rowId: Long) {
        usedRowIds.add(rowId)
        while (usedRowIds.size > 50) usedRowIds.remove(usedRowIds.first())
    }

    private fun publicState(call: IncomingCall): String = when (call.state) {
        STATE_RESOLVING -> STATE_RINGING
        STATE_ENDING -> if (call.answeredAt > 0 && !call.waiting) STATE_ANSWERED else STATE_RINGING
        else -> call.state
    }

    private fun emit(json: String) = CallEventBus.emitIncoming(json)

    private fun buildEvent(
        call: IncomingCall,
        state: String,
        endedAt: Long?,
        answered: Boolean = state == STATE_ANSWERED,
        durationSec: Long = 0L,
        simSlot: Int = -1,
        callLogType: Int? = null,
    ): String = JSONObject()
        .put("id", call.id)
        .put("phone", call.phone)
        .put("state", state)
        .put("answered", answered)
        .put("missed", state == STATE_ENDED && !answered)
        .put("durationSec", durationSec)
        .put("startedAt", call.startedAt)
        .put("endedAt", endedAt ?: JSONObject.NULL)
        .put("simSlot", simSlot)
        .put("callLogType", callLogType ?: JSONObject.NULL)
        .toString()
}
