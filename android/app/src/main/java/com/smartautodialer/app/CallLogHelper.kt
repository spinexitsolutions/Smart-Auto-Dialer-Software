package com.smartautodialer.app

import android.Manifest
import android.content.Context
import android.provider.CallLog
import android.util.Log

/** Reads the system call log: talk-time of dialed calls, number/outcome of received calls. */
object CallLogHelper {

    private const val TAG = "CallLogHelper"
    private const val MAX_ROWS_TO_SCAN = 25

    data class Entry(val number: String, val durationSec: Long, val dateMs: Long)

    /** A received (incoming / missed / rejected / blocked) call-log row. */
    data class IncomingEntry(
        val rowId: Long,
        val number: String,
        val durationSec: Long,
        val dateMs: Long,
        /** CallLog.Calls.TYPE (INCOMING_TYPE, MISSED_TYPE, REJECTED_TYPE, BLOCKED_TYPE). */
        val type: Int,
        /** CallLog.Calls.PHONE_ACCOUNT_ID (SIM), may be null. */
        val phoneAccountId: String?,
    )

    private val INCOMING_TYPES = intArrayOf(
        CallLog.Calls.INCOMING_TYPE,
        CallLog.Calls.MISSED_TYPE,
        CallLog.Calls.REJECTED_TYPE, // API 24 (= minSdk)
        CallLog.Calls.BLOCKED_TYPE,  // API 24 (= minSdk)
    )

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

    /**
     * Most recent received call (incoming, missed, rejected or blocked) logged at or after
     * [sinceMs], skipping rows in [excludeRowIds]. If [phone] is non-empty, a row with the same
     * number (last-10-digit match) is preferred; otherwise / if none matches, the most recent row
     * is returned. When [rejectOnly] is set, INCOMING_TYPE rows are ignored (used to detect a
     * call-waiting call that was declined while another call continues).
     * Returns null if not found or the permission is missing. Blocking; call off the main thread.
     */
    fun findIncomingCall(
        context: Context,
        phone: String,
        sinceMs: Long,
        excludeRowIds: Set<Long> = emptySet(),
        rejectOnly: Boolean = false,
    ): IncomingEntry? {
        if (!canRead(context)) return null
        val target = PhoneUtils.last10(phone)
        val types = if (rejectOnly) INCOMING_TYPES.filter { it != CallLog.Calls.INCOMING_TYPE } else INCOMING_TYPES.toList()

        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.DURATION,
            CallLog.Calls.DATE,
            CallLog.Calls.TYPE,
            CallLog.Calls.PHONE_ACCOUNT_ID,
        )
        val placeholders = types.joinToString(",") { "?" }
        val selection = "${CallLog.Calls.TYPE} IN ($placeholders) AND ${CallLog.Calls.DATE} >= ?"
        val args = (types.map { it.toString() } + sinceMs.toString()).toTypedArray()

        return try {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI, projection, selection, args, "${CallLog.Calls.DATE} DESC"
            )?.use { c ->
                val iId = c.getColumnIndexOrThrow(CallLog.Calls._ID)
                val iNumber = c.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
                val iDuration = c.getColumnIndexOrThrow(CallLog.Calls.DURATION)
                val iDate = c.getColumnIndexOrThrow(CallLog.Calls.DATE)
                val iType = c.getColumnIndexOrThrow(CallLog.Calls.TYPE)
                val iAccount = c.getColumnIndexOrThrow(CallLog.Calls.PHONE_ACCOUNT_ID)
                var newest: IncomingEntry? = null
                var scanned = 0
                while (c.moveToNext() && scanned++ < MAX_ROWS_TO_SCAN) {
                    val rowId = c.getLong(iId)
                    if (rowId in excludeRowIds) continue
                    val entry = IncomingEntry(
                        rowId = rowId,
                        // Private / unknown callers are logged with an empty number.
                        number = c.getString(iNumber).orEmpty(),
                        durationSec = c.getLong(iDuration).coerceAtLeast(0L),
                        dateMs = c.getLong(iDate),
                        type = c.getInt(iType),
                        phoneAccountId = if (c.isNull(iAccount)) null else c.getString(iAccount),
                    )
                    if (target.isEmpty()) return@use entry
                    if (PhoneUtils.last10(entry.number) == target) return@use entry
                    if (newest == null) newest = entry
                }
                newest
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
