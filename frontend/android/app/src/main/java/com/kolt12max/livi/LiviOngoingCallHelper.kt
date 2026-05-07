package com.kolt12max.livi

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Хранит данные текущего вызова (исходящий/входящий) и возвращает PendingIntent
 * для уведомления CallKeep: по нажатию открывается OutgoingCallActivity или IncomingCallActivity.
 */
object LiviOngoingCallHelper {
    private const val PREFS_NAME = "livi_ongoing_call"
    private const val KEY_TYPE = "type" // "outgoing" | "incoming"
    private const val KEY_CALL_ID = "callId"
    private const val KEY_TO_USER_ID = "toUserId"
    private const val KEY_TO_NICK = "toNick"
    private const val KEY_FROM = "from"
    private const val KEY_FROM_NICK = "fromNick"

    fun setOutgoingCall(context: Context, callId: String, toUserId: String, toNick: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_TYPE, "outgoing")
            .putString(KEY_CALL_ID, callId)
            .putString(KEY_TO_USER_ID, toUserId)
            .putString(KEY_TO_NICK, toNick ?: "")
            .apply()
    }

    fun setIncomingCall(context: Context, callId: String, from: String, fromNick: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_TYPE, "incoming")
            .putString(KEY_CALL_ID, callId)
            .putString(KEY_FROM, from)
            .putString(KEY_FROM_NICK, fromNick ?: "")
            .apply()
    }

    /** Для исходящего вызова вернуть (toUserId, toNick); иначе null. Нужно для запуска LiviOutgoingCallService из notifyOutgoingCallId. */
    @JvmStatic
    fun getOutgoingToUserAndNick(context: Context): Pair<String, String>? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_TYPE, null) != "outgoing") return null
        val toUserId = prefs.getString(KEY_TO_USER_ID, null) ?: return null
        val toNick = prefs.getString(KEY_TO_NICK, "") ?: ""
        return Pair(toUserId, toNick)
    }

    fun clearOngoingCall(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
    }

    /** Не очищает prefs: перед clearOngoingCall — передать callId/toUserId/toNick в intent «close immediately». */
    @JvmStatic
    fun peekOutgoingCall(context: Context): Triple<String, String, String>? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_TYPE, null) != "outgoing") return null
        val callId = prefs.getString(KEY_CALL_ID, null) ?: return null
        val toUserId = prefs.getString(KEY_TO_USER_ID, "") ?: ""
        val toNick = prefs.getString(KEY_TO_NICK, "") ?: ""
        return Triple(callId, toUserId, toNick)
    }

    /** Не очищает prefs: для JS presence — пока висит нативный входящий, синхронизировать setIncomingCallScreenVisible. */
    @JvmStatic
    fun peekIncomingCall(context: Context): Triple<String, String, String>? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_TYPE, null) != "incoming") return null
        val callId = prefs.getString(KEY_CALL_ID, null) ?: return null
        val from = prefs.getString(KEY_FROM, null) ?: return null
        val fromNick = prefs.getString(KEY_FROM_NICK, "") ?: ""
        return Triple(callId, from, fromNick)
    }

    /**
     * Если есть активный экран звонка (исходящий/входящий), запускает его и возвращает true.
     * Нужно при открытии приложения из лаунчера (кнопка Домой → иконка LiVi): показываем экран звонка, а не главный.
     */
    @JvmStatic
    fun launchOngoingCallActivityIfNeeded(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val type = prefs.getString(KEY_TYPE, null) ?: return false
        val callId = prefs.getString(KEY_CALL_ID, null) ?: return false
        val intent = when (type) {
            "outgoing" -> {
                val toUserId = prefs.getString(KEY_TO_USER_ID, "") ?: ""
                val toNick = prefs.getString(KEY_TO_NICK, "") ?: ""
                Intent(context, OutgoingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick)
                }
            }
            "incoming" -> {
                val from = prefs.getString(KEY_FROM, "") ?: ""
                val fromNick = prefs.getString(KEY_FROM_NICK, "") ?: ""
                Intent(context, IncomingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
                    putExtra(IncomingCallActivity.EXTRA_FROM, from)
                    putExtra(IncomingCallActivity.EXTRA_FROM_NICK, fromNick)
                }
            }
            else -> return false
        }
        context.startActivity(intent)
        return true
    }

    /**
     * Вызывается из патча VoiceConnectionService: по нажатию на уведомление открываем наш экран звонка.
     */
    @JvmStatic
    fun getPendingIntent(context: Context): PendingIntent? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val type = prefs.getString(KEY_TYPE, null) ?: return null
        val callId = prefs.getString(KEY_CALL_ID, null) ?: return null

        val intent = when (type) {
            "outgoing" -> {
                val toUserId = prefs.getString(KEY_TO_USER_ID, "") ?: ""
                val toNick = prefs.getString(KEY_TO_NICK, "") ?: ""
                Intent(context, OutgoingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick)
                }
            }
            "incoming" -> {
                val from = prefs.getString(KEY_FROM, "") ?: ""
                val fromNick = prefs.getString(KEY_FROM_NICK, "") ?: ""
                Intent(context, IncomingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
                    putExtra(IncomingCallActivity.EXTRA_FROM, from)
                    putExtra(IncomingCallActivity.EXTRA_FROM_NICK, fromNick)
                }
            }
            else -> return null
        }

        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getActivity(context, 1002, intent, flags)
    }
}
