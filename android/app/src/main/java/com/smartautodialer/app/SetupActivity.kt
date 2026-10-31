package com.smartautodialer.app

import android.content.Intent
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.smartautodialer.app.databinding.ActivitySetupBinding
import com.smartautodialer.app.databinding.ItemPermissionBinding
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * First-launch setup (also reachable later via Settings > Change server):
 *  1. Server URL (validated / normalised, optional connectivity test).
 *  2. Runtime permissions with a plain-language explanation for each.
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private lateinit var prefs: Prefs
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    private val fromSettings: Boolean
        get() = intent.getBooleanExtra(EXTRA_FROM_SETTINGS, false)

    /** True when the permission prompt was triggered by "Save and continue". */
    private var continueAfterPermissions = false

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            renderPermissions()
            if (continueAfterPermissions) {
                continueAfterPermissions = false
                proceedIfPermissionsOk()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.get(this)
        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (savedInstanceState == null) {
            binding.serverUrlInput.setText(prefs.serverUrl)
        }
        binding.serverUrlInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                testConnection()
                true
            } else {
                false
            }
        }
        binding.testButton.setOnClickListener { testConnection() }
        binding.grantButton.setOnClickListener { requestPermissions(continueAfter = false) }
        binding.continueButton.setOnClickListener { onContinueClicked() }
    }

    override fun onResume() {
        super.onResume()
        // The user may come back from the system settings page with new grants.
        renderPermissions()
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ server URL

    private fun readServerUrl(): String? {
        val normalized = Prefs.normalizeServerUrl(binding.serverUrlInput.text?.toString())
        binding.serverUrlLayout.error = if (normalized == null) getString(R.string.setup_invalid_url) else null
        return normalized
    }

    private fun testConnection() {
        val url = readServerUrl() ?: return
        binding.testButton.isEnabled = false
        binding.connectionStatus.setTextColor(binding.serverUrlLayout.helperTextCurrentTextColor)
        binding.connectionStatus.text = getString(R.string.setup_testing)
        executor.execute {
            val result = Http.checkReachable(url)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                binding.testButton.isEnabled = true
                result.onSuccess { code ->
                    binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.status_ok))
                    binding.connectionStatus.text = getString(R.string.setup_reachable, code)
                }.onFailure { e ->
                    binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.status_error))
                    binding.connectionStatus.text =
                        getString(R.string.setup_unreachable, e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    // ------------------------------------------------------------------ permissions

    private fun renderPermissions() {
        val list = binding.permissionList
        list.removeAllViews()
        Permissions.items().forEach { item ->
            val row = ItemPermissionBinding.inflate(layoutInflater, list, false)
            row.permTitle.setText(item.title)
            row.permReason.setText(item.reason)
            val granted = Permissions.has(this, item.permission)
            row.permStatus.setText(
                when {
                    granted -> R.string.perm_status_granted
                    item.required -> R.string.perm_status_missing_required
                    else -> R.string.perm_status_missing_optional
                }
            )
            row.permStatus.setTextColor(
                ContextCompat.getColor(
                    this,
                    if (granted) R.color.status_ok else if (item.required) R.color.status_error else android.R.color.darker_gray
                )
            )
            list.addView(row.root)
        }
        binding.grantButton.isEnabled = Permissions.missing(this).isNotEmpty()
    }

    private fun requestPermissions(continueAfter: Boolean) {
        val missing = Permissions.missing(this).map { it.permission }
        if (missing.isEmpty()) {
            if (continueAfter) proceedIfPermissionsOk()
            return
        }
        continueAfterPermissions = continueAfter
        permissionLauncher.launch(missing.toTypedArray())
    }

    // ------------------------------------------------------------------ continue

    private fun onContinueClicked() {
        val url = readServerUrl() ?: return
        prefs.serverUrl = url
        requestPermissions(continueAfter = true)
    }

    private fun proceedIfPermissionsOk() {
        val missingRequired = Permissions.missingRequired(this)
        if (missingRequired.isEmpty()) {
            completeSetup()
            return
        }
        val message = buildString {
            append(getString(R.string.perm_denied_message)).append("\n\n")
            missingRequired.forEach {
                append("• ").append(getString(it.title)).append(" - ").append(getString(it.reason)).append("\n")
            }
            append("\n").append(getString(R.string.perm_denied_footer))
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.perm_denied_title)
            .setMessage(message)
            .setPositiveButton(R.string.perm_open_settings) { _, _ ->
                startActivity(Permissions.appSettingsIntent(this))
            }
            .setNegativeButton(R.string.perm_continue_anyway) { _, _ -> completeSetup() }
            .show()
    }

    private fun completeSetup() {
        prefs.setupCompleted = true
        if (!fromSettings) {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            )
        }
        finish()
    }

    companion object {
        /** When true the screen just closes on completion (MainActivity is already running). */
        const val EXTRA_FROM_SETTINGS = "from_settings"
    }
}
