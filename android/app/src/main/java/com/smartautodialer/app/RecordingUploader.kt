package com.smartautodialer.app

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Schedules recording uploads after answered calls. */
object RecordingUploader {

    private const val TAG = "RecordingUploader"
    const val WORK_TAG = "recording-upload"

    /** Delay before looking for the file, giving the recorder time to finalise it. */
    private const val INITIAL_DELAY_SEC = 4L

    fun enqueue(context: Context, callId: String, phone: String, startedAt: Long, endedAt: Long) {
        val prefs = Prefs.get(context)
        if (!prefs.recordingUploadEnabled || callId.isBlank()) return
        try {
            val request = OneTimeWorkRequestBuilder<RecordingUploadWorker>()
                .setInputData(
                    workDataOf(
                        RecordingUploadWorker.KEY_CALL_ID to callId,
                        RecordingUploadWorker.KEY_PHONE to phone,
                        RecordingUploadWorker.KEY_STARTED_AT to startedAt,
                        RecordingUploadWorker.KEY_ENDED_AT to endedAt,
                    )
                )
                .setInitialDelay(INITIAL_DELAY_SEC, TimeUnit.SECONDS)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(WORK_TAG)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork("recording-$callId", ExistingWorkPolicy.KEEP, request)
        } catch (e: Exception) {
            Log.w(TAG, "Unable to enqueue recording upload", e)
        }
    }
}

/**
 * Finds the recording for one call and uploads it as multipart/form-data to
 * `POST <server>/api/calls/<callId>/recording` (field `file`, Bearer token).
 */
class RecordingUploadWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        val callId = inputData.getString(KEY_CALL_ID) ?: return Result.failure()
        val phone = inputData.getString(KEY_PHONE).orEmpty()
        val startedAt = inputData.getLong(KEY_STARTED_AT, 0L)
        val endedAt = inputData.getLong(KEY_ENDED_AT, System.currentTimeMillis())
        val prefs = Prefs.get(applicationContext)

        if (!prefs.recordingUploadEnabled) return Result.success()
        val server = prefs.serverUrl
        if (server.isBlank()) return Result.failure()

        val recording = try {
            RecordingFinder.find(
                applicationContext,
                prefs.recordingFolder,
                fromMs = startedAt - START_TOLERANCE_MS,
                toMs = endedAt + END_GRACE_MS,
                phone = phone,
            )
        } catch (e: Exception) {
            Log.w(TAG, "Recording lookup failed", e)
            null
        }

        if (recording == null) {
            Log.i(TAG, "No recording yet for call $callId (attempt $runAttemptCount)")
            return if (runAttemptCount < MAX_FIND_ATTEMPTS) Result.retry() else Result.failure()
        }

        return try {
            upload(server, prefs.authToken, callId, phone, startedAt, endedAt, recording)
        } catch (e: IOException) {
            Log.w(TAG, "Upload failed for call $callId", e)
            if (runAttemptCount < MAX_UPLOAD_ATTEMPTS) Result.retry() else Result.failure()
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected upload error for call $callId", e)
            Result.failure()
        }
    }

    private fun upload(
        server: String,
        token: String,
        callId: String,
        phone: String,
        startedAt: Long,
        endedAt: Long,
        recording: RecordingFile,
    ): Result {
        val mediaType = mimeTypeFor(recording.name).toMediaTypeOrNull()
        // Exact length for plain files; content URIs stream chunked (MediaStore SIZE can be stale).
        val length = recording.file?.length() ?: -1L
        val fileBody = StreamRequestBody(mediaType, length) { recording.open(applicationContext) }

        // Text fields first so servers (e.g. multer) see them before the file part.
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("callId", callId)
            .addFormDataPart("phone", phone)
            .addFormDataPart("startedAt", startedAt.toString())
            .addFormDataPart("endedAt", endedAt.toString())
            .addFormDataPart("file", recording.name, fileBody)
            .build()

        val url = "${server.trimEnd('/')}/api/calls/${Uri.encode(callId)}/recording"
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", Http.userAgent)
            .apply { if (token.isNotBlank()) header("Authorization", "Bearer $token") }
            .post(body)
            .build()

        Http.client.newCall(request).execute().use { response ->
            val code = response.code
            Log.i(TAG, "Upload ${recording.name} for $callId -> HTTP $code")
            return when {
                response.isSuccessful -> Result.success()
                // Token may be refreshed by the web panel later; server may be restarting.
                code == 401 || code == 403 || code == 408 || code == 429 || code >= 500 ->
                    if (runAttemptCount < MAX_UPLOAD_ATTEMPTS) Result.retry() else Result.failure()
                else -> Result.failure()
            }
        }
    }

    private fun mimeTypeFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "amr" -> "audio/amr"
        "awb" -> "audio/amr-wb"
        "wav" -> "audio/wav"
        "ogg" -> "audio/ogg"
        "opus" -> "audio/opus"
        "3gp", "3ga" -> "audio/3gpp"
        else -> "application/octet-stream"
    }

    /** Streams the recording from disk / content URI; re-opens the stream on each retry. */
    private class StreamRequestBody(
        private val mediaType: MediaType?,
        private val length: Long,
        private val opener: () -> java.io.InputStream?,
    ) : RequestBody() {
        override fun contentType(): MediaType? = mediaType
        override fun contentLength(): Long = if (length > 0) length else -1L
        override fun writeTo(sink: BufferedSink) {
            val input = opener() ?: throw IOException("Cannot open recording")
            input.source().use { sink.writeAll(it) }
        }
    }

    companion object {
        private const val TAG = "RecordingUploadWorker"
        const val KEY_CALL_ID = "callId"
        const val KEY_PHONE = "phone"
        const val KEY_STARTED_AT = "startedAt"
        const val KEY_ENDED_AT = "endedAt"

        /** Recorders may finish writing late; look a few times before giving up. */
        private const val MAX_FIND_ATTEMPTS = 3
        private const val MAX_UPLOAD_ATTEMPTS = 6
        private const val START_TOLERANCE_MS = 5_000L
        private const val END_GRACE_MS = 120_000L
    }
}
