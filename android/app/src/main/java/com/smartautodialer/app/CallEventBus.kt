package com.smartautodialer.app

import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Ordered, at-least-once delivery of native events to the web panel.
 *
 * There is one independent queue per JavaScript handler ([METHOD_CALL_STATE] ->
 * `window.SADNative.onCallState`, [METHOD_INCOMING_CALL] -> `window.SADNative.onIncomingCall`),
 * so a page that does not (yet) implement one handler never blocks the other. Within a queue
 * events are delivered strictly in order, one at a time, to the attached [Sink] (MainActivity's
 * WebView). If no WebView exists, or the page has not yet defined the handler, events stay
 * queued and are retried on the next [flush] (page load, activity resume,
 * `AndroidDialer.flushEvents()`, new event, or a short retry timer).
 *
 * All state is confined to the main thread.
 */
object CallEventBus {

    /** Something that can hand a JSON event to a `window.SADNative.<method>` handler. */
    interface Sink {
        /** Deliver [json] to `window.SADNative[method]`; invoke [onResult] with true if the page accepted it. */
        fun deliver(method: String, json: String, onResult: (Boolean) -> Unit)
    }

    const val METHOD_CALL_STATE = "onCallState"
    const val METHOD_INCOMING_CALL = "onIncomingCall"

    private const val TAG = "CallEventBus"
    private const val MAX_QUEUE = 100
    private const val DELIVERY_TIMEOUT_MS = 5_000L
    private const val RETRY_DELAY_MS = 3_000L

    private val main = Handler(Looper.getMainLooper())
    private var sink: Sink? = null

    private val channels = listOf(Channel(METHOD_CALL_STATE), Channel(METHOD_INCOMING_CALL))

    fun attach(newSink: Sink) = onMain {
        sink = newSink
        channels.forEach { it.reset(); it.deliverNext() }
    }

    fun detach(oldSink: Sink) = onMain {
        if (sink === oldSink) {
            sink = null
            channels.forEach { it.reset() }
        }
    }

    /** Outgoing-call event for `window.SADNative.onCallState`. */
    fun emit(json: String) = emitTo(METHOD_CALL_STATE, json)

    /** Incoming-call event for `window.SADNative.onIncomingCall`. */
    fun emitIncoming(json: String) = emitTo(METHOD_INCOMING_CALL, json)

    fun flush() = onMain { channels.forEach { it.deliverNext() } }

    private fun emitTo(method: String, json: String) = onMain {
        Log.d(TAG, "emit $method $json")
        val channel = channels.first { it.method == method }
        channel.enqueue(json)
        channel.deliverNext()
    }

    private class Channel(val method: String) {
        private val pending = ArrayDeque<String>()
        private var inFlight = false
        private var inFlightToken = 0
        private val retryRunnable = Runnable { deliverNext() }

        fun enqueue(json: String) {
            pending.addLast(json)
            while (pending.size > MAX_QUEUE) pending.removeFirst()
        }

        fun reset() {
            inFlight = false
            main.removeCallbacks(retryRunnable)
        }

        fun deliverNext() {
            val target = sink ?: return
            if (inFlight || pending.isEmpty()) return
            main.removeCallbacks(retryRunnable)

            inFlight = true
            val token = ++inFlightToken
            val event = pending.first()
            val timeout = Runnable {
                if (inFlight && token == inFlightToken) {
                    inFlight = false
                    scheduleRetry()
                }
            }
            main.postDelayed(timeout, DELIVERY_TIMEOUT_MS)

            target.deliver(method, event) { delivered ->
                main.removeCallbacks(timeout)
                if (!inFlight || token != inFlightToken) return@deliver
                inFlight = false
                if (delivered) {
                    if (pending.firstOrNull() === event) pending.removeFirst()
                    deliverNext()
                } else {
                    scheduleRetry()
                }
            }
        }

        private fun scheduleRetry() {
            if (sink == null || pending.isEmpty()) return
            main.removeCallbacks(retryRunnable)
            main.postDelayed(retryRunnable, RETRY_DELAY_MS)
        }
    }

    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }
}
