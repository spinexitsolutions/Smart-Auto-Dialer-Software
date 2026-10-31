import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ============================================================================
// WHITE-LABEL CONFIGURATION
// Change these values (or override them in gradle.properties / with -P flags)
// to rebrand the app. See README.md > "White-labelling".
// ============================================================================
fun prop(name: String, default: String): String =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: default

val brandAppName = prop("sad.appName", "Smart Auto Dialer")
val brandApplicationId = prop("sad.applicationId", "com.smartautodialer.app")
// Leave empty to force the agent to type the server URL on first launch.
// When set, the setup screen is pre-filled with this value.
val brandDefaultServerUrl = prop("sad.defaultServerUrl", "")
val brandVersionCode = prop("sad.versionCode", "1").toInt()
val brandVersionName = prop("sad.versionName", "1.0.0")

// ============================================================================
// Release signing: create android/keystore.properties (see README.md).
// ============================================================================
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystorePropsFile.exists()

android {
    namespace = "com.smartautodialer.app"
    compileSdk = 34

    defaultConfig {
        applicationId = brandApplicationId
        minSdk = 24
        targetSdk = 34
        versionCode = brandVersionCode
        versionName = brandVersionName

        buildConfigField("String", "DEFAULT_SERVER_URL", "\"${brandDefaultServerUrl.replace("\"", "")}\"")
        resValue("string", "app_name", brandAppName)
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "WARNING: android/keystore.properties not found - the release APK is signed " +
                        "with the DEBUG key. Do not distribute it; see README.md > Signing."
                )
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    packaging {
        resources.excludes += setOf("META-INF/{AL2.0,LGPL2.1}", "META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
