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
    private const val KEY_INCOMING_STARTED_AT_MS = "incomingStartedAtMs"

    /** Совпадает с JS OUTGOING_CALL_TIMEOUT_MS / FCM ring window. */
    private const val INCOMING_RING_WINDOW_MS = 27_000L

    fun setOutgoingCall(context: Context, callId: String, toUserId: String, toNick: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_TYPE, "outgoing")
            .putString(KEY_CALL_ID, callId)
            .putString(KEY_TO_USER_ID, toUserId)
            .putString(KEY_TO_NICK, toNick ?: "")
            .remove(KEY_INCOMING_STARTED_AT_MS)
            .apply()
    }

    fun setIncomingCall(context: Context, callId: String, from: String, fromNick: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_TYPE, "incoming")
            .putString(KEY_CALL_ID, callId)
            .putString(KEY_FROM, from)
            .putString(KEY_FROM_NICK, fromNick ?: "")
            .putLong(KEY_INCOMING_STARTED_AT_MS, System.currentTimeMillis())
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

    @JvmStatic
    fun clearOngoingCallIfMatches(context: Context, callId: String) {
        if (callId.isBlank()) return
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_CALL_ID, null) == callId.trim()) {
            clearOngoingCall(context)
        }
    }

    /** Не показывать/не восстанавливать входящий (лаунчер, CallKeep PI, JS peek). */
    @JvmStatic
    fun shouldSuppressStaleIncoming(context: Context, callId: String): Boolean {
        if (callId.isBlank()) return true
        if (EndedCallIds.isEnded(context, callId)) return true
        return isIncomingRingWindowExpired(context, callId)
    }

    private fun isIncomingRingWindowExpired(context: Context, callId: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        var startedAt = 0L
        if (prefs.getString(KEY_CALL_ID, null) == callId.trim()) {
            startedAt = prefs.getLong(KEY_INCOMING_STARTED_AT_MS, 0L)
        }
        if (startedAt <= 0L) {
            startedAt = LiviAppModule.incomingCallMetaStartedAtMs(context, callId)
        }
        if (startedAt <= 0L) return false
        return System.currentTimeMillis() >= startedAt + INCOMING_RING_WINDOW_MS
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
        if (shouldSuppressStaleIncoming(context, callId)) {
            clearOngoingCallIfMatches(context, callId)
            return null
        }
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
        if (type == "incoming" && shouldSuppressStaleIncoming(context, callId)) {
            clearOngoingCallIfMatches(context, callId)
            return false
        }
        if (type == "outgoing" && EndedCallIds.isEnded(context, callId)) {
            clearOngoingCall(context)
            return false
        }
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
        if (type == "incoming" && shouldSuppressStaleIncoming(context, callId)) {
            clearOngoingCallIfMatches(context, callId)
            return null
        }
        if (EndedCallIds.isEnded(context, callId)) {
            clearOngoingCall(context)
            return null
        }

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
