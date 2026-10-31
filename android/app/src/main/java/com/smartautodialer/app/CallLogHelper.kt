package com.smartautodialer.app

import android.Manifest
import android.content.Context
import android.provider.CallLog
import android.util.Log

/** Reads the system call log to find the real talk-time of a call placed by the dialer. */
object CallLogHelper {

    private const val TAG = "CallLogHelper"
    private const val MAX_ROWS_TO_SCAN = 25

    data class Entry(val number: String, val durationSec: Long, val dateMs: Long)

    fun canRead(context: Context): Boolean =
        Permissions.has(context, Manifest.permission.READ_CALL_LOG)

    /**
     * Most recent OUTGOING call to [phone] (last-10-digit match) logged at or after [sinceMs].
     * Returns null if not found or the permission is missing. Blocking; call off the main thread.
     */
    fun findOutgoingCall(context: Context, phone: String, sinceMs: Long): Entry? {
        if (!canRead(context)) return null
        val target = PhoneUtils.last10(phone)
        if (target.isEmpty()) return null

        val projection = arrayOf(
            CallLog.Calls.NUMBER,
            CallLog.Calls.DURATION,
            CallLog.Calls.DATE,
        )
        val selection = "${CallLog.Calls.TYPE} = ? AND ${CallLog.Calls.DATE} >= ?"
        val args = arrayOf(CallLog.Calls.OUTGOING_TYPE.toString(), sinceMs.toString())

        return try {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI, projection, selection, args, "${CallLog.Calls.DATE} DESC"
            )?.use { c ->
                val iNumber = c.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
                val iDuration = c.getColumnIndexOrThrow(CallLog.Calls.DURATION)
                val iDate = c.getColumnIndexOrThrow(CallLog.Calls.DATE)
                var scanned = 0
                while (c.moveToNext() && scanned++ < MAX_ROWS_TO_SCAN) {
                    val number = c.getString(iNumber) ?: continue
                    if (PhoneUtils.last10(number) == target) {
                        return@use Entry(number, c.getLong(iDuration).coerceAtLeast(0L), c.getLong(iDate))
                    }
                }
                null
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Call log not readable", e)
            null
        } catch (e: Exception) {
            Log.w(TAG, "Call log query failed", e)
            null
        }
    }
}
