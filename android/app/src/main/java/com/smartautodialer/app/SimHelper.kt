package com.smartautodialer.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/** SIM-card discovery and SIM-slot to PhoneAccountHandle mapping. */
object SimHelper {

    private const val TAG = "SimHelper"

    /**
     * JSON array describing active SIMs:
     * `[{"slot":0,"subscriptionId":1,"label":"Jio 4G","carrier":"Jio","number":"+91..."}]`.
     * Returns `[]` if READ_PHONE_STATE is not granted or anything fails.
     */
    @SuppressLint("MissingPermission")
    fun getSimsJson(context: Context): String {
        val result = JSONArray()
        if (!Permissions.has(context, Manifest.permission.READ_PHONE_STATE)) return result.toString()
        try {
            val sm = context.getSystemService(SubscriptionManager::class.java) ?: return result.toString()
            val subs: List<SubscriptionInfo> = sm.activeSubscriptionInfoList ?: emptyList()
            subs.sortedBy { it.simSlotIndex }.forEach { info ->
                result.put(
                    JSONObject()
                        .put("slot", info.simSlotIndex)
                        .put("subscriptionId", info.subscriptionId)
                        .put("label", label(info))
                        .put("carrier", info.carrierName?.toString().orEmpty())
                        .put("number", phoneNumber(context, sm, info))
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unable to list SIMs", e)
        }
        return result.toString()
    }

    private fun label(info: SubscriptionInfo): String {
        val display = info.displayName?.toString()?.trim().orEmpty()
        if (display.isNotEmpty()) return display
        val carrier = info.carrierName?.toString()?.trim().orEmpty()
        return carrier.ifEmpty { "SIM ${info.simSlotIndex + 1}" }
    }

    @SuppressLint("MissingPermission")
    private fun phoneNumber(context: Context, sm: SubscriptionManager, info: SubscriptionInfo): String = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (Permissions.has(context, Manifest.permission.READ_PHONE_NUMBERS)) {
                sm.getPhoneNumber(info.subscriptionId)
            } else {
                ""
            }
        } else {
            legacyNumber(info)
        }
    } catch (e: Exception) {
        ""
    }

    @Suppress("DEPRECATION")
    private fun legacyNumber(info: SubscriptionInfo): String = info.number.orEmpty()

    /**
     * Finds the PhoneAccountHandle for a physical SIM slot (0-based), or null to let
     * the system use the default / ask the user.
     */
    @SuppressLint("MissingPermission")
    fun phoneAccountForSlot(context: Context, slot: Int): PhoneAccountHandle? {
        if (slot < 0 || !Permissions.has(context, Manifest.permission.READ_PHONE_STATE)) return null
        return try {
            val telecom = context.getSystemService(TelecomManager::class.java) ?: return null
            val handles: List<PhoneAccountHandle> = telecom.callCapablePhoneAccounts ?: emptyList()
            if (handles.isEmpty()) return null

            val info = context.getSystemService(SubscriptionManager::class.java)
                ?.getActiveSubscriptionInfoForSimSlotIndex(slot)

            if (info != null) {
                // Android 11+: exact mapping handle -> subscription id.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val tm = context.getSystemService(TelephonyManager::class.java)
                    if (tm != null) {
                        handles.firstOrNull { tm.getSubscriptionId(it) == info.subscriptionId }?.let { return it }
                    }
                }
                // Older devices: handle id is usually the subscription id or the ICCID.
                val subId = info.subscriptionId.toString()
                val iccId = info.iccId.orEmpty()
                handles.firstOrNull { h ->
                    h.id == subId || (iccId.isNotEmpty() && (h.id == iccId || h.id.startsWith(iccId)))
                }?.let { return it }
            }
            // Last resort: handles are normally ordered by slot.
            if (handles.size > 1) handles.getOrNull(slot) else null
        } catch (e: Exception) {
            Log.w(TAG, "Unable to resolve phone account for slot $slot", e)
            null
        }
    }

    /**
     * Maps a call-log PHONE_ACCOUNT_ID back to a 0-based SIM slot, or -1 if unknown.
     * The id is usually the subscription id (or the ICCID on some older devices).
     */
    @SuppressLint("MissingPermission")
    fun slotForPhoneAccountId(context: Context, accountId: String?): Int {
        if (accountId.isNullOrBlank() || !Permissions.has(context, Manifest.permission.READ_PHONE_STATE)) return -1
        return try {
            val sm = context.getSystemService(SubscriptionManager::class.java) ?: return -1
            val subs: List<SubscriptionInfo> = sm.activeSubscriptionInfoList ?: emptyList()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val telecom = context.getSystemService(TelecomManager::class.java)
                val tm = context.getSystemService(TelephonyManager::class.java)
                if (telecom != null && tm != null) {
                    val handle = (telecom.callCapablePhoneAccounts ?: emptyList()).firstOrNull { it.id == accountId }
                    if (handle != null) {
                        val subId = tm.getSubscriptionId(handle)
                        subs.firstOrNull { it.subscriptionId == subId }?.let { return it.simSlotIndex }
                    }
                }
            }
            subs.firstOrNull { info ->
                val iccId = info.iccId.orEmpty()
                accountId == info.subscriptionId.toString() ||
                    (iccId.isNotEmpty() && (accountId == iccId || accountId.startsWith(iccId) || iccId.startsWith(accountId)))
            }?.simSlotIndex ?: -1
        } catch (e: Exception) {
            Log.w(TAG, "Unable to map phone account $accountId to a SIM slot", e)
            -1
        }
    }
}
