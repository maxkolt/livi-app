package com.kolt12max.livi

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * Единственный FCM-сервис приложения: расширяет Expo и перехватывает пуши о звонке.
 * Для type=call запускает headless JS → CallKeep (нативный экран входящего звонка при убитом/фоне).
 * Остальные пуши передаёт в Expo (super.onMessageReceived).
 */
class LiviFirebaseMessagingService : ExpoFirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data ?: emptyMap()
        Log.d(TAG, "FCM onMessageReceived data keys: ${data.keys}")

        var type = data["type"]
        var callId = data["callId"]
        var from = data["from"] ?: data["fromUserId"]
        var fromNick = data["fromNick"] ?: ""

        // Expo может отправлять payload в data["body"] как JSON
        if (type == null && data["body"] != null) {
            try {
                val body = JSONObject(data["body"]!!)
                type = body.optString("type", "").takeIf { it.isNotEmpty() }
                callId = body.optString("callId", "").takeIf { it.isNotEmpty() }
                from = body.optString("from", "").takeIf { it.isNotEmpty() } ?: body.optString("fromUserId", "").takeIf { it.isNotEmpty() }
                fromNick = body.optString("fromNick", "")
            } catch (e: Exception) {
                Log.w(TAG, "FCM parse body failed", e)
            }
        }

        if (type == "call" && callId != null && from != null) {
            Log.d(TAG, "FCM call push: callId=$callId from=$from fromNick=$fromNick")
            val intent = Intent().apply {
                setClassName(applicationContext, "io.wazo.callkeep.RNCallKeepBackgroundMessagingService")
                putExtra("type", "call")
                putExtra("callId", callId)
                putExtra("from", from)
                putExtra("fromNick", fromNick)
            }
            try {
                applicationContext.startService(intent)
                Log.d(TAG, "FCM started RNCallKeepBackgroundMessagingService")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start RNCallKeepBackgroundMessagingService", e)
            }
            return
        }
        super.onMessageReceived(remoteMessage)
    }

    companion object {
        private const val TAG = "LiviFCM"
    }
}
