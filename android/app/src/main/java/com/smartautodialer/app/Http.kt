package com.smartautodialer.app

import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** Shared OkHttp client (one connection pool for the whole app). */
object Http {

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    val userAgent: String
        get() = "SmartAutoDialer-Android/${BuildConfig.VERSION_NAME}"

    /**
     * Blocking reachability check used by the setup screen. Any HTTP response
     * (even 404) means the server is reachable. Must not be called on the main thread.
     */
    fun checkReachable(baseUrl: String): Result<Int> = runCatching {
        val quickClient = client.newBuilder().callTimeout(10, TimeUnit.SECONDS).build()
        val request = Request.Builder().url(baseUrl).header("User-Agent", userAgent).get().build()
        quickClient.newCall(request).execute().use { it.code }
    }
}
