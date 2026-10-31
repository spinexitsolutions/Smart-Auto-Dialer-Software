package com.smartautodialer.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.smartautodialer.app.databinding.ActivitySettingsBinding

/** Native settings: server, auto-return, overlay permission, display, recording upload. */
class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private lateinit var prefs: Prefs

    private val audioPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                Snackbar.make(binding.root, R.string.settings_audio_permission_denied, Snackbar.LENGTH_LONG)
                    .setAction(R.string.perm_open_settings) {
                        startActivity(Permissions.appSettingsIntent(this))
                    }
                    .show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.get(this)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.toolbar.setNavigationOnClickListener { finish() }

        // Server
        binding.changeServerButton.setOnClickListener { openSetup() }

        // Calls
        binding.autoReturnSwitch.isChecked = prefs.autoReturn
        binding.autoReturnSwitch.setOnCheckedChangeListener { _, checked -> prefs.autoReturn = checked }
        binding.overlayButton.setOnClickListener { openOverlaySettings() }

        // Display
        binding.keepScreenOnSwitch.isChecked = prefs.keepScreenOn
        binding.keepScreenOnSwitch.setOnCheckedChangeListener { _, checked -> prefs.keepScreenOn = checked }
        binding.pullToRefreshSwitch.isChecked = prefs.pullToRefresh
        binding.pullToRefreshSwitch.setOnCheckedChangeListener { _, checked -> prefs.pullToRefresh = checked }

        // Recordings
        binding.recordingSwitch.isChecked = prefs.recordingUploadEnabled
        binding.recordingSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.recordingUploadEnabled = checked
            updateRecordingUi()
            val permission = Permissions.audioReadPermission()
            if (checked && !Permissions.has(this, permission)) audioPermissionLauncher.launch(permission)
        }
        binding.recordingFolderInput.setText(prefs.recordingFolder)
        binding.recordingFolderInput.doAfterTextChanged { prefs.recordingFolder = it?.toString().orEmpty() }
        binding.presetsButton.setOnClickListener { showFolderPresets() }
        updateRecordingUi()

        // System
        binding.permissionsButton.setOnClickListener { openSetup() }
        binding.batteryButton.setOnClickListener {
            safeStart(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        binding.versionText.text = getString(R.string.settings_version, BuildConfig.VERSION_NAME)
    }

    override fun onResume() {
        super.onResume()
        binding.serverUrlText.text = prefs.serverUrl
        val overlayAllowed = Settings.canDrawOverlays(this)
        binding.overlayStatus.setText(
            if (overlayAllowed) R.string.settings_overlay_granted else R.string.settings_overlay_denied
        )
        binding.overlayButton.isEnabled = !overlayAllowed
    }

    private fun updateRecordingUi() {
        val enabled = binding.recordingSwitch.isChecked
        binding.recordingFolderLayout.isEnabled = enabled
        binding.presetsButton.isEnabled = enabled
    }

    private fun showFolderPresets() {
        val items: Array<CharSequence> = RecordingFinder.PRESETS.toTypedArray()
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.settings_recording_presets)
            .setItems(items) { _, which -> binding.recordingFolderInput.setText(RecordingFinder.PRESETS[which]) }
            .show()
    }

    private fun openSetup() {
        startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_FROM_SETTINGS, true))
    }

    private fun openOverlaySettings() {
        val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
        if (!safeStart(intent)) safeStart(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
    }

    private fun safeStart(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        Toast.makeText(this, R.string.error_no_app, Toast.LENGTH_SHORT).show()
        false
    }
}
