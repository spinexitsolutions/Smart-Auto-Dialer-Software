# Smart Auto Dialer – Android companion app

A thin native shell around the web **agent panel** plus a native bridge that places
real SIM calls, tracks call state, reports call duration from the call log and
(optionally) uploads call recordings.

```
┌───────────────────────────── Android phone ─────────────────────────────┐
│  MainActivity ── WebView ── <server>/?native=1#/agent  (web agent panel) │
│        │             ▲  window.AndroidDialer.dial(...)                    │
│        │             └─ window.SADNative.onCallState("{json}")            │
│  DialerBridge ──► CallPlacer (ACTION_CALL + SIM selection)                │
│  CallStateService (foreground, "Dialer connected")                        │
│        └─► CallTracker ─► CallLogHelper (duration) ─► CallEventBus ─► JS  │
│                       └─► RecordingUploader (WorkManager + OkHttp)        │
└──────────────────────────────────────────────────────────────────────────┘
```

* Kotlin, Gradle Kotlin DSL, AGP 8.5, compileSdk/targetSdk 34, minSdk 24 (Android 7.0)
* applicationId `com.smartautodialer.app`
* Dependencies: androidx core/appcompat/activity, Material Components, SwipeRefreshLayout, WorkManager, OkHttp

---

## 1. Build the APK

### Android Studio (recommended)
1. Install Android Studio (Koala or newer) – it bundles the JDK 17 and Android SDK.
2. **File ▸ Open…** and choose this `android/` folder (not the repository root).
3. Let Gradle sync. If Studio says the Gradle wrapper is missing, accept its offer to
   create it, or run `gradle wrapper --gradle-version 8.7` once in this folder.
4. **Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s)**.
   The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.
5. For a release build: **Build ▸ Generate Signed Bundle / APK…** (see *Signing*), or use the CLI below.

### Command line
The wrapper JAR is intentionally not committed (binary). Generate it once:

```bash
cd android
gradle wrapper --gradle-version 8.7      # needs any local Gradle 8.x; only once
echo "sdk.dir=$HOME/Android/Sdk" > local.properties   # or set ANDROID_HOME
./gradlew assembleDebug                   # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease                 # app/build/outputs/apk/release/app-release.apk
```

Install on a connected phone: `adb install -r app/build/outputs/apk/release/app-release.apk`.

> The debug build uses the application id suffix `.debug`, so it can be installed side by side
> with the release build.

## 2. Signing

Create a keystore once and **keep it safe** – every future update must be signed with the
same key, otherwise phones refuse to install the update.

```bash
keytool -genkeypair -v -keystore smartdialer-release.jks -alias smartdialer \
        -keyalg RSA -keysize 4096 -validity 10000
```

Create `android/keystore.properties` (git-ignored):

```properties
storeFile=smartdialer-release.jks
storePassword=********
keyAlias=smartdialer
keyPassword=********
```

`storeFile` is relative to the `android/` folder. `./gradlew assembleRelease` then produces a
signed, minified APK. Without `keystore.properties` the release build falls back to the
**debug key** and prints a warning – fine for testing, never for distribution.

## 3. White-labelling

Everything brand-specific is in one place at the top of `app/build.gradle.kts`, and each value
can also be overridden from `gradle.properties` or the command line:

| What | Default | Override |
| --- | --- | --- |
| App name (launcher label) | `Smart Auto Dialer` | `-Psad.appName="Acme Dialer"` |
| Application id (Play/Store identity – must be unique per customer) | `com.smartautodialer.app` | `-Psad.applicationId=com.acme.dialer` |
| Default server URL (`BuildConfig.DEFAULT_SERVER_URL`) | empty | `-Psad.defaultServerUrl=https://dialer.acme.com` |
| Version | `1` / `1.0.0` | `-Psad.versionCode=2 -Psad.versionName=1.0.1` |

Example:

```bash
./gradlew assembleRelease -Psad.appName="Acme Dialer" \
  -Psad.applicationId=com.acme.dialer -Psad.defaultServerUrl=https://dialer.acme.com
```

* **Colours**: `app/src/main/res/values/colors.xml` (`brand_primary`, `ic_launcher_background`, …).
* **Icon**: vector artwork in `res/drawable/ic_launcher_foreground.xml` (adaptive icon, Android 8+)
  and `res/mipmap/ic_launcher.xml` (Android 7.x). Replace the path data, or use
  Android Studio's *New ▸ Image Asset* wizard.
* **Texts**: `res/values/strings.xml` (no brand name hard-coded there; the app name comes from Gradle).
* The Kotlin `namespace` (`com.smartautodialer.app`) does **not** need to change when you change
  the applicationId.

When `DEFAULT_SERVER_URL` is set, the setup screen is pre-filled with it; agents just tap
*Save and continue*.

## 4. How it works

1. **First launch** – `SetupActivity` asks for the server URL (normalised: `dialer.acme.com` →
   `https://dialer.acme.com`, `192.168.1.5:3000` → `http://192.168.1.5:3000`), offers a
   connection test, then requests runtime permissions and explains any that are denied.
2. **MainActivity** loads `<server>/?native=1#/agent` in a full-screen WebView
   (JavaScript, DOM storage, cookies, file chooser for CSV upload, mixed content allowed for LAN
   HTTP). It survives rotation (handles `configChanges` itself). Back navigates WebView history;
   at the root it moves the app to the background instead of closing it.
3. **Change server / settings** is reachable from: long-press on the launcher icon ▸ *Dialer
   settings*; the *Settings* action on the "Dialer connected" notification; the error screen;
   and from the web via `AndroidDialer.openSettings()`.
4. **CallStateService** is a foreground service (type `phoneCall`, falling back to `dataSync`)
   that listens to call state (TelephonyCallback on Android 12+, PhoneStateListener below).
5. **CallTracker**: `dial()` → `dialing`; `OFFHOOK` → `offhook`; back to `IDLE` → waits 1.5 s,
   reads the newest OUTGOING call-log entry to that number (last 10 digits) since the dial time
   (retries up to 3×) → `ended` with `durationSec` and `connected = durationSec > 0`.
   If the phone never goes off-hook within 60 s the attempt ends with `error:"call_not_started"`.
6. Events are queued in `CallEventBus` and delivered in order to
   `window.SADNative.onCallState(jsonString)`; undelivered events are retried on page load,
   activity resume, every 3 s, and when the page calls `AndroidDialer.flushEvents()`.

## 5. JavaScript contract (for the web panel)

`window.AndroidDialer` (all methods synchronous):

| Method | Returns | Notes |
| --- | --- | --- |
| `isAvailable()` | `true` | |
| `getSims()` | JSON string `[{"slot":0,"subscriptionId":1,"label":"Jio 4G","carrier":"Jio","number":"+91…"}]` | `[]` without READ_PHONE_STATE. `number` is often empty (carrier doesn't store it). |
| `getDeviceInfo()` | JSON string `{"model","manufacturer","brand","android","sdk","appVersion","appVersionCode","applicationId"}` | |
| `setAuthToken(token)` | – | JWT used for native recording uploads. Call after login and whenever it is refreshed; `""` on logout. |
| `dial(callId, phone, simSlot)` | `boolean` | `simSlot` 0-based, **`-1` = default SIM**. Always pass an integer. |
| `endCall()` | `boolean` | Android 9+ with "Manage calls" permission, else `false`. |
| `openWhatsApp(phone, text)` | – | Opens `https://wa.me/<digits>?text=…`. Pass the number **with country code**. |
| `sendSms(phone, text)` | – | Opens the SMS app pre-filled (user presses send). |
| `setAutoReturn(enabled)` | – | Bring the app back after each call. |
| `flushEvents()` | – | Extra. Call once after defining `window.SADNative`. |
| `getCurrentCall()` | JSON string or `"null"` | Extra. Call currently being tracked. |
| `getPermissions()` | JSON string `{"CALL_PHONE":true,…,"SYSTEM_ALERT_WINDOW":false}` | Extra. |
| `requestPermissions()` | – | Extra. Shows the system prompt for missing permissions. |
| `openSettings()` | – | Extra. Opens the native settings screen. |
| `setKeepScreenOn(enabled)` | – | Extra. |
| `getAppVersion()`, `getServerUrl()`, `isRecordingUploadEnabled()` | string / string / boolean | Extra. |

Native → web: `window.SADNative.onCallState(jsonString)` – **the argument is a JSON string**;
use `JSON.parse`. Shape:

```json
{
  "callId": "abc123", "phone": "+919876543210",
  "state": "dialing | offhook | ended",
  "durationSec": 42, "connected": true,
  "startedAt": 1735000000000, "endedAt": 1735000060000,
  "simSlot": 0,
  "offhookAt": 1735000001000,      // present once off-hook
  "callLogFound": true,            // "ended" only; false = duration unknown (no call-log permission / not logged)
  "offhookSec": 58,                // "ended" only; off-hook time incl. ringing (fallback estimate)
  "error": "permission_denied"     // "ended" only, when the attempt failed
}
```

`endedAt` is `null` until the call has ended. Possible `error` values: `permission_denied`,
`no_dialer_app`, `invalid_number`, `dial_failed`, `call_not_started`, `superseded`
(a new `dial()` arrived before the previous call finished). Every `dial()` is guaranteed to
end with exactly one `ended` event. Optional: `window.SADNative.onPermissions(jsonString)`
is called after the user answers a permission prompt.

The User-Agent contains `SmartAutoDialer/<version> AndroidDialer`, and the page URL has `?native=1`.

## 6. Permissions

| Permission | Why |
| --- | --- |
| `CALL_PHONE` (required) | Place calls directly from the SIM. |
| `READ_PHONE_STATE` (required) | Detect call start/end; list SIM cards; map SIM slot → phone account. |
| `READ_CALL_LOG` (required) | Read the real talk time to decide connected / not connected. |
| `READ_PHONE_NUMBERS` | Show each SIM's own number (when the carrier provides it). |
| `ANSWER_PHONE_CALLS` | `endCall()` – hang up from the panel (Android 9+). |
| `POST_NOTIFICATIONS` (Android 13+) | "Dialer connected" status and "tap to return" notifications. |
| `READ_MEDIA_AUDIO` / `READ_EXTERNAL_STORAGE` | Find call recordings to upload (only if enabled). |
| `RECORD_AUDIO` (optional) | Only granted to the panel if it requests the microphone. |
| `FOREGROUND_SERVICE_*`, `MANAGE_OWN_CALLS` | Install-time; needed for the Android 14 `phoneCall` foreground-service type. |
| `SYSTEM_ALERT_WINDOW` (optional, via Settings) | Makes auto-return after a call reliable on Android 10+. |

**Android 13+ "Restricted settings"**: when the APK is side-loaded (not from a store), Android
may block Call log / SMS-class permissions. Ask agents to open *App info ▸ ⋮ ▸ Allow restricted
settings* and then grant the permission. The app's permission dialog mentions this.

Also recommend excluding the app from battery optimisation (*Settings ▸ Battery optimisation*
button in the app), especially on Xiaomi, Oppo/Realme, Vivo and Huawei.

## 7. Google Play policy

Google Play restricts `READ_CALL_LOG` (and SMS permissions) to apps that are the device's
default phone/SMS handler or qualify for a listed exception. A companion dialer that is **not**
the default dialer will most likely be rejected. Options:

* **Distribute the APK directly** (your website, WhatsApp, e-mail) or via an
  **MDM / Managed Google Play private app** for enterprise customers – recommended.
* Apply for a Permissions Declaration exception (call-log access for CRM / "enterprise
  telephony" use cases); approval is not guaranteed.
* Ship a Play variant without `READ_CALL_LOG` – then `callLogFound` is `false`, `durationSec` is
  `0`, and the server must rely on agent dispositions (or `offhookSec` as a rough estimate).

## 8. Call-recording upload – limitations

* Android does **not** allow third-party apps to record calls since Android 10. This app only
  uploads files written by the phone's **built-in** call recorder (Samsung, Xiaomi, Oppo/Realme,
  OnePlus, Vivo, … – availability depends on model and country). Google-Dialer phones
  (Pixel, Motorola, Nokia) usually announce recording to both parties or don't support it.
* The agent must switch on automatic call recording in the phone's dialer, enable
  *Upload call recordings* in the app settings, and pick the correct folder (presets provided).
* After an answered call the worker waits ~4 s, then looks for the newest audio file
  (`mp3/m4a/amr/wav/aac/ogg/opus/3gp/awb`) modified during the call (MediaStore + direct file
  scan), preferring files whose name contains the dialed number, and uploads it with
  `POST <server>/api/calls/<callId>/recording` (multipart field `file`, fields `callId`, `phone`,
  `startedAt`, `endedAt`, header `Authorization: Bearer <token>`). It retries with exponential
  backoff when the file isn't there yet, the network is down, or the server returns 401/403/408/429/5xx.
* Some recorders only write the file minutes later or into app-private storage; such
  recordings cannot be picked up.

## 9. Auto-return after a call – limitation

Android 10+ blocks apps from opening an activity while in the background. The foreground
service alone is not enough. For a reliable return, the agent grants **Display over other
apps** from *Settings ▸ Allow "Display over other apps"*. Without it the app still tries, and
additionally shows a heads-up *"Call ended – tap to return"* notification.

## 10. Project layout

```
android/
├── build.gradle.kts, settings.gradle.kts, gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle.kts            # white-label + signing config
    ├── proguard-rules.pro          # keeps @JavascriptInterface methods
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/smartautodialer/app/
        │   ├── DialerApp.kt            # Application: channels, launcher shortcut
        │   ├── MainActivity.kt         # WebView host, CallEventBus sink
        │   ├── SetupActivity.kt        # server URL + permissions
        │   ├── SettingsActivity.kt     # native settings
        │   ├── DialerBridge.kt         # window.AndroidDialer
        │   ├── CallPlacer.kt           # ACTION_CALL + SIM selection extras
        │   ├── SimHelper.kt            # SubscriptionManager / PhoneAccountHandle
        │   ├── CallStateService.kt     # foreground service, call-state listener
        │   ├── CallTracker.kt          # dialing → offhook → ended state machine
        │   ├── CallLogHelper.kt        # duration lookup
        │   ├── CallEventBus.kt         # ordered delivery to window.SADNative
        │   ├── RecordingFinder.kt      # locate recording file
        │   ├── RecordingUploader.kt    # WorkManager worker + OkHttp multipart
        │   ├── Notifications.kt, Permissions.kt, Prefs.kt, PhoneUtils.kt, Http.kt
        └── res/  (layouts, vector icons, strings, themes, network security config)
```

## 11. Troubleshooting

* **Blank page / error screen** – check the URL from the phone's browser; on a LAN make sure
  the phone is on the same Wi-Fi. Self-signed HTTPS certificates are rejected (install the CA
  on the phone, or use plain HTTP on the LAN).
* **Calls go out on the wrong SIM** – some OEM dialers ignore the SIM-selection extras; set
  "Ask every time" or the desired default SIM in the phone's settings.
* **Duration always 0** – grant *Call log* (see *Restricted settings* above).
* **Debugging** – debug builds enable `chrome://inspect` WebView debugging; logs use tags
  `CallTracker`, `CallStateService`, `CallEventBus`, `RecordingUploadWorker`.
