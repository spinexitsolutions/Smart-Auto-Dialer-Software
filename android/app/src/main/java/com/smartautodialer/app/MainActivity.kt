package com.smartautodialer.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.snackbar.Snackbar
import com.smartautodialer.app.databinding.ActivityMainBinding
import org.json.JSONObject

/**
 * Hosts the web agent panel (`<server>/?native=1#/agent`) in a full-screen WebView and
 * exposes [DialerBridge] as `window.AndroidDialer`.
 *
 * The activity handles its own configuration changes (see manifest) so the WebView and the
 * page state survive rotation, and it is `singleTask` so there is only ever one panel.
 */
class MainActivity : AppCompatActivity(), CallEventBus.Sink {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    /** Server URL the WebView was last loaded with; used to detect a server change. */
    private var loadedServerUrl: String? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var webViewAlive = false
    private var permissionSnackbarShown = false

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = fileChooserCallback
            fileChooserCallback = null
            callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            // (Re)start the service so it registers the call-state listener if now allowed.
            CallStateService.start(this)
            notifyWebPermissionsChanged()
        }

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.get(this)

        if (!prefs.setupCompleted || prefs.serverUrl.isBlank()) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configureWebView(binding.webView)
        configureRefresh()
        configureErrorView()
        configureBackNavigation()

        CallEventBus.attach(this)
        CallStateService.start(this)

        val restored = savedInstanceState != null && binding.webView.restoreState(savedInstanceState) != null
        if (restored) loadedServerUrl = prefs.serverUrl else loadPanel()
    }

    override fun onResume() {
        super.onResume()
        if (!::binding.isInitialized) return
        AppVisibility.mainActivityResumed = true
        binding.webView.onResume()
        applyKeepScreenOn()
        Notifications.cancelIncomingCall(this)
        binding.swipeRefresh.isEnabled = prefs.pullToRefresh
        Notifications.cancelReturnToApp(this)

        if (loadedServerUrl != prefs.serverUrl) loadPanel()
        CallStateService.start(this)
        CallEventBus.flush()
        maybeShowPermissionHint()
    }

    override fun onPause() {
        AppVisibility.mainActivityResumed = false
        if (::binding.isInitialized) {
            // Note: WebView.onPause() does not pause JavaScript, so the panel keeps receiving
            // call events and keeps its socket connection while the dialer UI is in front.
            binding.webView.onPause()
            CookieManager.getInstance().flush()
        }
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::binding.isInitialized && webViewAlive) binding.webView.saveState(outState)
    }

    override fun onDestroy() {
        if (::binding.isInitialized) {
            CallEventBus.detach(this)
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = null
            if (webViewAlive) {
                webViewAlive = false
                binding.webView.apply {
                    removeJavascriptInterface(DialerBridge.JS_NAME)
                    stopLoading()
                    (parent as? ViewGroup)?.removeView(this)
                    destroy()
                }
            }
        }
        super.onDestroy()
    }

    // ------------------------------------------------------------------ CallEventBus.Sink

    override fun deliver(method: String, json: String, onResult: (Boolean) -> Unit) {
        if (!webViewAlive || isDestroyed) {
            onResult(false)
            return
        }
        // Returns true only if the page has registered window.SADNative[method]
        // (onCallState / onIncomingCall). A throwing handler still counts as delivered so one
        // bad event cannot block the queue.
        val m = JSONObject.quote(method)
        val script = "(function(){var m=$m;try{if(window.SADNative&&typeof window.SADNative[m]==='function'){" +
            "window.SADNative[m](${JSONObject.quote(json)});return true;}}" +
            "catch(e){console.error('SADNative.'+m+' failed',e);return true;}return false;})()"
        binding.webView.evaluateJavascript(script) { result -> onResult(result == "true") }
    }

    // ------------------------------------------------------------------ public helpers (bridge)

    fun requestMissingPermissions() {
        val missing = Permissions.missing(this).map { it.permission }
        if (missing.isEmpty()) {
            notifyWebPermissionsChanged()
            return
        }
        try {
            permissionLauncher.launch(missing.toTypedArray())
        } catch (e: Exception) {
            Log.w(TAG, "Permission request failed", e)
        }
    }

    fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    fun applyKeepScreenOn() {
        if (prefs.keepScreenOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ------------------------------------------------------------------ WebView setup

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(webView: WebView) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webViewAlive = true

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            allowContentAccess = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString SmartAutoDialer/${BuildConfig.VERSION_NAME} AndroidDialer"
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.addJavascriptInterface(DialerBridge(this), DialerBridge.JS_NAME)
        webView.webViewClient = PanelWebViewClient()
        webView.webChromeClient = PanelChromeClient()
        webView.setDownloadListener { url, _, _, _, _ ->
            // Blob/data downloads cannot be handed to another app; real URLs open in the browser.
            if (url.startsWith("http://") || url.startsWith("https://")) {
                openExternal(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
        }
    }

    private fun configureRefresh() {
        binding.swipeRefresh.setColorSchemeResources(R.color.brand_primary)
        binding.swipeRefresh.isEnabled = prefs.pullToRefresh
        // Only trigger when the page itself is scrolled to the top.
        binding.swipeRefresh.setOnChildScrollUpCallback { _, _ -> binding.webView.scrollY > 0 }
        binding.swipeRefresh.setOnRefreshListener { binding.webView.reload() }
    }

    private fun configureErrorView() {
        binding.retryButton.setOnClickListener {
            hideError()
            if (loadedServerUrl != prefs.serverUrl || binding.webView.url.isNullOrEmpty()) loadPanel()
            else binding.webView.reload()
        }
        binding.changeServerButton.setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_FROM_SETTINGS, true))
        }
        binding.errorSettingsButton.setOnClickListener { openSettings() }
    }

    private fun configureBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    binding.errorView.visibility == View.VISIBLE && binding.webView.canGoBack() -> {
                        hideError()
                        binding.webView.goBack()
                    }
                    binding.webView.canGoBack() -> binding.webView.goBack()
                    // Keep the WebView (and the call-tracking session) alive instead of finishing.
                    else -> moveTaskToBack(true)
                }
            }
        })
    }

    private fun loadPanel() {
        val url = prefs.panelUrl()
        loadedServerUrl = prefs.serverUrl
        hideError()
        Log.i(TAG, "Loading panel $url")
        binding.webView.loadUrl(url)
    }

    // ------------------------------------------------------------------ helpers

    private fun showError(message: CharSequence) {
        binding.errorMessage.text = message
        binding.errorView.visibility = View.VISIBLE
        binding.progress.visibility = View.GONE
        binding.swipeRefresh.isRefreshing = false
    }

    private fun hideError() {
        binding.errorView.visibility = View.GONE
    }

    private fun isPanelUrl(uri: Uri): Boolean {
        val server = Uri.parse(prefs.serverUrl)
        return uri.host.equals(server.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(server)
    }

    private fun effectivePort(uri: Uri): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        else -> 80
    }

    private fun openExternal(intent: Intent) {
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.error_no_app, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.w(TAG, "Unable to open external link", e)
        }
    }

    private fun maybeShowPermissionHint() {
        if (permissionSnackbarShown || Permissions.missingRequired(this).isEmpty()) return
        permissionSnackbarShown = true
        Snackbar.make(binding.root, R.string.perm_missing_snackbar, Snackbar.LENGTH_INDEFINITE)
            .setAction(R.string.perm_grant) { requestMissingPermissions() }
            .show()
    }

    /** Optional hook for the web: `window.SADNative.onPermissions(jsonString)`. */
    private fun notifyWebPermissionsChanged() {
        if (!webViewAlive) return
        val json = JSONObject.quote(Permissions.statusJson(this))
        binding.webView.evaluateJavascript(
            "window.SADNative&&typeof window.SADNative.onPermissions==='function'&&window.SADNative.onPermissions($json)",
            null
        )
    }

    // ------------------------------------------------------------------ WebView clients

    private inner class PanelWebViewClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val scheme = uri.scheme?.lowercase()
            if ((scheme == "http" || scheme == "https") && isPanelUrl(uri)) return false
            if (scheme == "intent") {
                try {
                    val intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                        .addCategory(Intent.CATEGORY_BROWSABLE)
                    intent.component = null
                    intent.selector = null
                    startActivity(intent)
                } catch (e: Exception) {
                    val fallback = try {
                        Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).getStringExtra("browser_fallback_url")
                    } catch (ignored: Exception) {
                        null
                    }
                    if (fallback != null) openExternal(Intent(Intent.ACTION_VIEW, Uri.parse(fallback)))
                }
                return true
            }
            // tel:, sms:, mailto:, whatsapp:, external https links...
            openExternal(Intent(Intent.ACTION_VIEW, uri))
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            binding.progress.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String?) {
            binding.progress.visibility = View.GONE
            binding.swipeRefresh.isRefreshing = false
            CallEventBus.flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                showError("${error.description} (${prefs.serverUrl})")
            }
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // Never proceed on invalid certificates; use a valid cert or plain HTTP on the LAN.
            handler.cancel()
            showError(getString(R.string.error_ssl))
        }

        @RequiresApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "WebView renderer gone (crash=${detail.didCrash()}); recreating")
            webViewAlive = false
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            recreate()
            return true
        }
    }

    private inner class PanelChromeClient : WebChromeClient() {

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            binding.progress.setProgressCompat(newProgress, true)
            if (newProgress >= 100) binding.progress.visibility = View.GONE
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = filePathCallback
            // "*/*": many file managers report CSV as octet-stream, so filtering by accept= hides them.
            val pick = Intent(Intent.ACTION_GET_CONTENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            return try {
                fileChooserLauncher.launch(Intent.createChooser(pick, getString(R.string.file_chooser_title)))
                true
            } catch (e: Exception) {
                Log.w(TAG, "File chooser unavailable", e)
                fileChooserCallback = null
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // Only grant the microphone, only to our own server, only if the app holds RECORD_AUDIO.
            val wantsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
            if (wantsAudio && isPanelUrl(request.origin) &&
                Permissions.has(this@MainActivity, Manifest.permission.RECORD_AUDIO)
            ) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                request.deny()
            }
        }
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}
