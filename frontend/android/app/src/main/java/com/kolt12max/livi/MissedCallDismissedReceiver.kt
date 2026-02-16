package com.kolt12max.livi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Вызывается, когда пользователь смахнул уведомление «Пропущенный вызов».
 * Обнуляем счётчик для этого userId, чтобы следующий пропущенный от того же пользователя начал счёт с 1.
 */
class MissedCallDismissedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null || intent == null) return
        if (intent.action != LiviAppModule.ACTION_MISSED_CALL_DISMISSED) return
        val userId = intent.getStringExtra(LiviAppModule.EXTRA_USER_ID) ?: return
        LiviAppModule.clearMissedCountForUser(context, userId)
        Log.d(TAG, "Missed call notification dismissed, cleared count for userId=$userId")
    }

    companion object {
        private const val TAG = "MissedCallDismissed"
    }
}
