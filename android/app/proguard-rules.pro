# ---- WebView JavaScript bridge -------------------------------------------
# Methods annotated with @JavascriptInterface are called reflectively by the
# WebView. They must keep their names or the web panel cannot reach them.
-keepattributes JavascriptInterface
-keepclassmembers class com.smartautodialer.app.DialerBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ---- WorkManager workers (instantiated by class name) ---------------------
-keep class com.smartautodialer.app.RecordingUploadWorker { <init>(...); }

# ---- OkHttp / Okio --------------------------------------------------------
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
