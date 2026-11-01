package com.smartautodialer.app

import android.content.Context
import android.content.SharedPreferences
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * Typed wrapper around the app's SharedPreferences.
 *
 * All accessors are thread-safe (SharedPreferences is), so they may be used from the
 * JavaScript bridge thread, WorkManager workers and the main thread alike.
 */
class Prefs private constructor(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    /** Base URL of the dialer server without trailing slash, e.g. `https://dialer.acme.com`. */
    var serverUrl: String
        get() = sp.getString(KEY_SERVER_URL, null)?.takeIf { it.isNotBlank() }
            ?: normalizeServerUrl(BuildConfig.DEFAULT_SERVER_URL).orEmpty()
        set(value) = sp.edit().putString(KEY_SERVER_URL, normalizeServerUrl(value) ?: value.trim()).apply()

    /** True once the agent has completed the first-launch setup screen. */
    var setupCompleted: Boolean
        get() = sp.getBoolean(KEY_SETUP_DONE, false)
        set(value) = sp.edit().putBoolean(KEY_SETUP_DONE, value).apply()

    /** JWT handed over by the web panel; used as `Authorization: Bearer <token>` for native uploads. */
    var authToken: String
        get() = sp.getString(KEY_AUTH_TOKEN, "").orEmpty()
        set(value) = sp.edit().putString(KEY_AUTH_TOKEN, value).apply()

    var autoReturn: Boolean
        get() = sp.getBoolean(KEY_AUTO_RETURN, true)
        set(value) = sp.edit().putBoolean(KEY_AUTO_RETURN, value).apply()

    var keepScreenOn: Boolean
        get() = sp.getBoolean(KEY_KEEP_SCREEN_ON, false)
        set(value) = sp.edit().putBoolean(KEY_KEEP_SCREEN_ON, value).apply()

    var pullToRefresh: Boolean
        get() = sp.getBoolean(KEY_PULL_TO_REFRESH, false)
        set(value) = sp.edit().putBoolean(KEY_PULL_TO_REFRESH, value).apply()

    var recordingUploadEnabled: Boolean
        get() = sp.getBoolean(KEY_RECORDING_ENABLED, false)
        set(value) = sp.edit().putBoolean(KEY_RECORDING_ENABLED, value).apply()

    /** Folder (relative to primary external storage) where the phone saves call recordings. */
    var recordingFolder: String
        get() = sp.getString(KEY_RECORDING_FOLDER, null) ?: RecordingFinder.DEFAULT_FOLDER
        set(value) = sp.edit().putString(KEY_RECORDING_FOLDER, value.trim()).apply()

    /** The call currently being tracked; persisted so tracking survives process death. */
    var activeCall: ActiveCall?
        get() = ActiveCall.fromJson(sp.getString(KEY_ACTIVE_CALL, null))
        set(value) {
            sp.edit().apply {
                if (value == null) remove(KEY_ACTIVE_CALL) else putString(KEY_ACTIVE_CALL, value.toJson())
            }.apply()
        }

    /** Report calls received on the phone to the panel (`window.SADNative.onIncomingCall`). */
    var incomingTracking: Boolean
        get() = sp.getBoolean(KEY_INCOMING_TRACKING, true)
        set(value) = sp.edit().putBoolean(KEY_INCOMING_TRACKING, value).apply()

    /** Incoming calls currently being tracked (normally 0 or 1; 2 with call waiting). */
    var activeIncoming: List<IncomingCall>
        get() = IncomingCall.listFromJson(sp.getString(KEY_ACTIVE_INCOMING, null))
        set(value) {
            sp.edit().apply {
                if (value.isEmpty()) remove(KEY_ACTIVE_INCOMING)
                else putString(KEY_ACTIVE_INCOMING, IncomingCall.listToJson(value))
            }.apply()
        }

    /** URL of the agent panel loaded in the WebView. */
    fun panelUrl(): String = "${serverUrl.trimEnd('/')}/?native=1#/agent"

    companion object {
        private const val FILE_NAME = "smart_auto_dialer"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_SETUP_DONE = "setup_completed"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_AUTO_RETURN = "auto_return"
        private const val KEY_KEEP_SCREEN_ON = "keep_screen_on"
        private const val KEY_PULL_TO_REFRESH = "pull_to_refresh"
        private const val KEY_RECORDING_ENABLED = "recording_upload_enabled"
        private const val KEY_RECORDING_FOLDER = "recording_folder"
        private const val KEY_ACTIVE_CALL = "active_call"
        private const val KEY_INCOMING_TRACKING = "incoming_tracking"
        private const val KEY_ACTIVE_INCOMING = "active_incoming"

        @Volatile
        private var instance: Prefs? = null

        fun get(context: Context): Prefs =
            instance ?: synchronized(this) {
                instance ?: Prefs(context).also { instance = it }
            }

        private val IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")

        /**
         * Normalises what an agent types into a usable base URL, or returns null if invalid.
         *  - "dialer.acme.com"          -> "https://dialer.acme.com"
         *  - "192.168.1.5:3000"         -> "http://192.168.1.5:3000"
         *  - "https://x.com/#/agent"    -> "https://x.com"
         */
        fun normalizeServerUrl(raw: String?): String? {
            var s = raw?.trim().orEmpty()
            if (s.isEmpty()) return null
            s = s.substringBefore('#').substringBefore('?').trim()
            if (!s.contains("://")) {
                val host = s.substringBefore('/').substringBefore(':').lowercase()
                val local = host == "localhost" || IPV4.matches(host) || host.endsWith(".local")
                s = (if (local) "http://" else "https://") + s
            }
            val url = s.toHttpUrlOrNull() ?: return null
            if (url.host.isBlank()) return null
            return url.toString().trimEnd('/')
        }
    }
}

/** State of the call that was placed through [DialerBridge.dial]. */
data class ActiveCall(
    val callId: String,
    val phone: String,
    val simSlot: Int,
    /** Epoch ms when dial() was invoked. */
    val dialAt: Long,
    /** Epoch ms when the phone went OFFHOOK (0 if not yet). */
    val offhookAt: Long = 0L,
    /** Epoch ms when the phone returned to IDLE (0 if not yet). */
    val endedAt: Long = 0L,
    val state: String = CallTracker.STATE_DIALING,
) {
    /** Unique per dial attempt, even when the web re-dials with the same callId. */
    val token: String get() = "$callId@$dialAt"

    fun toJson(): String = JSONObject()
        .put("callId", callId)
        .put("phone", phone)
        .put("simSlot", simSlot)
        .put("dialAt", dialAt)
        .put("offhookAt", offhookAt)
        .put("endedAt", endedAt)
        .put("state", state)
        .toString()

    companion object {
        fun fromJson(json: String?): ActiveCall? {
            if (json.isNullOrBlank()) return null
            return try {
                val o = JSONObject(json)
                ActiveCall(
                    callId = o.getString("callId"),
                    phone = o.getString("phone"),
                    simSlot = o.optInt("simSlot", -1),
                    dialAt = o.getLong("dialAt"),
                    offhookAt = o.optLong("offhookAt", 0L),
                    endedAt = o.optLong("endedAt", 0L),
                    state = o.optString("state", CallTracker.STATE_DIALING),
                )
            } catch (e: Exception) {
                null
            }
        }
    }
}

/** State of a call received on the phone, tracked by [IncomingCallTracker]. */
data class IncomingCall(
    /** Local id, `in-<epochMs>`. */
    val id: String,
    /** Caller number; may be empty until filled from the call log. */
    val phone: String,
    /** Epoch ms when RINGING was observed. */
    val startedAt: Long,
    /** Epoch ms when it went OFFHOOK while ringing (0 if not). */
    val answeredAt: Long = 0L,
    /** Epoch ms when the phone returned to IDLE (0 if not yet). */
    val endedAt: Long = 0L,
    val state: String = IncomingCallTracker.STATE_RINGING,
    /** Arrived while another call was already off-hook (call waiting). */
    val waiting: Boolean = false,
) {
    fun toJsonObject(): JSONObject = JSONObject()
        .put("id", id)
        .put("phone", phone)
        .put("startedAt", startedAt)
        .put("answeredAt", answeredAt)
        .put("endedAt", endedAt)
        .put("state", state)
        .put("waiting", waiting)

    companion object {
        fun fromJsonObject(o: JSONObject): IncomingCall? = try {
            IncomingCall(
                id = o.getString("id"),
                phone = o.optString("phone", ""),
                startedAt = o.getLong("startedAt"),
                answeredAt = o.optLong("answeredAt", 0L),
                endedAt = o.optLong("endedAt", 0L),
                state = o.optString("state", IncomingCallTracker.STATE_RINGING),
                waiting = o.optBoolean("waiting", false),
            )
        } catch (e: Exception) {
            null
        }

        fun listToJson(calls: List<IncomingCall>): String {
            val a = JSONArray()
            calls.forEach { a.put(it.toJsonObject()) }
            return a.toString()
        }

        fun listFromJson(json: String?): List<IncomingCall> {
            if (json.isNullOrBlank()) return emptyList()
            return try {
                val a = JSONArray(json)
                (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { fromJsonObject(it) } }
            } catch (e: Exception) {
                emptyList()
            }
        }
    }
}
