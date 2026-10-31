package com.smartautodialer.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.telecom.TelecomManager
import android.util.Log

/** Places real SIM calls via ACTION_CALL, optionally forcing a specific SIM slot. */
object CallPlacer {

    private const val TAG = "CallPlacer"

    const val ERROR_PERMISSION = "permission_denied"
    const val ERROR_NO_DIALER = "no_dialer_app"
    const val ERROR_INVALID_NUMBER = "invalid_number"
    const val ERROR_UNKNOWN = "dial_failed"

    /**
     * Vendor-specific extras understood by various OEM dialers (Samsung, Xiaomi, Asus,
     * Huawei, Lenovo/Motorola, older AOSP forks) to select the outgoing SIM.
     */
    private val SLOT_EXTRAS = arrayOf(
        "com.android.phone.extra.slot",
        "slot",
        "simSlot",
        "sim_slot",
        "simslot",
        "slot_id",
        "slotId",
        "slotIdx",
        "simSlotIndex",
        "simId",
        "simnum",
        "phone",
        "phone_type",
        "subscription",
        "Subscription",
        "com.android.phone.DialingMode",
        "extra_asus_dial_use_dualsim",
    )

    /** @return null on success, otherwise one of the ERROR_* codes. */
    fun place(context: Context, phone: String, simSlot: Int): String? {
        if (phone.isEmpty()) return ERROR_INVALID_NUMBER
        if (!Permissions.has(context, Manifest.permission.CALL_PHONE)) return ERROR_PERMISSION

        val intent = Intent(Intent.ACTION_CALL, Uri.fromParts("tel", phone, null))
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        if (simSlot >= 0) {
            SimHelper.phoneAccountForSlot(context, simSlot)?.let {
                intent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it)
            }
            intent.putExtra("com.android.phone.force.slot", true)
            intent.putExtra("Cdma_Supp", true)
            SLOT_EXTRAS.forEach { intent.putExtra(it, simSlot) }
        }

        return try {
            context.startActivity(intent)
            null
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "No activity for ACTION_CALL", e)
            ERROR_NO_DIALER
        } catch (e: SecurityException) {
            Log.w(TAG, "CALL_PHONE rejected", e)
            ERROR_PERMISSION
        } catch (e: Exception) {
            Log.w(TAG, "Dial failed", e)
            ERROR_UNKNOWN
        }
    }
}
