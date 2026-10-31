package com.smartautodialer.app

import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Ordered, at-least-once delivery of call-state events to the web panel.
 *
 * Events are queued and delivered one at a time to the attached [Sink] (MainActivity's
 * WebView). If no WebView exists, or the page has not yet defined `window.SADNative`,
 * events stay queued and are retried on the next [flush] (page load, activity resume,
 * `AndroidDialer.flushEvents()`, new event, or a short retry timer).
 *
 * All state is confined to the main thread.
 */
object CallEventBus {

    /** Something that can hand a JSON event to JavaScript. */
    interface Sink {
        /** Deliver [json]; invoke [onResult] with true if the page accepted it. */
        fun deliver(json: String, onResult: (Boolean) -> Unit)
    }

    private const val TAG = "CallEventBus"
    private const val MAX_QUEUE = 100
    private const val DELIVERY_TIMEOUT_MS = 5_000L
    private const val RETRY_DELAY_MS = 3_000L

    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayDeque<String>()
    private var sink: Sink? = null
    private var inFlight = false
    private var inFlightToken = 0
    private val retryRunnable = Runnable { deliverNext() }

    fun attach(newSink: Sink) = onMain {
        sink = newSink
        inFlight = false
        deliverNext()
    }

    fun detach(oldSink: Sink) = onMain {
        if (sink === oldSink) {
            sink = null
            inFlight = false
            main.removeCallbacks(retryRunnable)
        }
    }

    fun emit(json: String) = onMain {
        Log.d(TAG, "emit $json")
        pending.addLast(json)
        while (pending.size > MAX_QUEUE) pending.removeFirst()
        deliverNext()
    }

    fun flush() = onMain { deliverNext() }

    private fun deliverNext() {
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

        target.deliver(event) { delivered ->
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

    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }
}
