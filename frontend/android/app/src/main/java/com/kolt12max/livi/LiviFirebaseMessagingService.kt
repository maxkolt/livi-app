package com.kolt12max.livi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * Единственный FCM-сервис приложения: расширяет Expo и перехватывает пуши о звонке.
 * Для type=call показывает уведомление с full-screen intent → IncomingCallActivity (как WhatsApp/Telegram).
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
            if (MainActivity.isInForeground) {
                Log.d(TAG, "FCM call push: app in foreground, skip notification (in-app UI will handle)")
                return
            }
            Log.d(TAG, "FCM call push: full-screen intent (WhatsApp/Telegram style) callId=$callId from=$from")
            showIncomingCallFullScreenIntent(callId, from, fromNick)
            return
        }
        if (type == "call_canceled" && callId != null) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
            val intent = Intent(ACTION_CALL_CANCELED).apply {
                setPackage(packageName)
                putExtra(EXTRA_CALL_ID, callId)
            }
            sendBroadcast(intent)
            Log.d(TAG, "FCM call_canceled: notification canceled, broadcast sent callId=$callId")
            return
        }
        // Получатель отклонил — закрыть нативный экран исходящего у звонящего (сокет в фоне может быть отключён).
        if (type == "call_declined" && callId != null) {
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeIntent)
            Log.d(TAG, "FCM call_declined: broadcast sent to close OutgoingCallActivity callId=$callId")
            return
        }
        super.onMessageReceived(remoteMessage)
    }

    private fun showIncomingCallFullScreenIntent(callId: String, from: String, fromNick: String) {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID_CALLS,
                getString(R.string.incoming_call_title),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                setSound(null, null)
                setVibrationPattern(longArrayOf(0, 500, 200, 500))
            }
            notificationManager.createNotificationChannel(channel)
        }

        val fullScreenIntent = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
            putExtra(IncomingCallActivity.EXTRA_FROM, from)
            putExtra(IncomingCallActivity.EXTRA_FROM_NICK, fromNick)
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID_INCOMING_CALL,
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerUri = Uri.parse("livi://answer-call?callId=${Uri.encode(callId)}&from=${Uri.encode(from)}&fromNick=${Uri.encode(fromNick)}")
        val answerIntent = Intent(Intent.ACTION_VIEW, answerUri).apply {
            setClassName(applicationContext, "com.kolt12max.livi.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        val answerPendingIntent = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID_INCOMING_CALL + 1,
            answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // «Отклонить» — через BroadcastReceiver: HTTP decline без открытия приложения (нет модалки Deep link received)
        val declineIntent = Intent(this, DeclineCallReceiver::class.java).apply {
            action = DeclineCallReceiver.ACTION_DECLINE_CALL
            putExtra(DeclineCallReceiver.EXTRA_CALL_ID, callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            this,
            NOTIFICATION_ID_INCOMING_CALL + 2,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = if (fromNick.isNotEmpty()) fromNick else getString(R.string.incoming_call_title)
        val subtitle = getString(R.string.incoming_call_title)

        val builder = NotificationCompat.Builder(this, CHANNEL_ID_CALLS)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle(title)
            .setContentText(subtitle)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setAutoCancel(true)
            .setTimeoutAfter(45_000)
            .setPriority(NotificationCompat.PRIORITY_MAX)

        try {
            val declineColor = ContextCompat.getColor(this, R.color.notification_call_decline)
            val acceptColor = ContextCompat.getColor(this, R.color.notification_call_accept)
            val customView = RemoteViews(packageName, R.layout.notification_incoming_call).apply {
                setTextViewText(R.id.notification_title, title)
                setTextViewText(R.id.notification_text, subtitle)
                setInt(R.id.notification_btn_decline, "setTextColor", declineColor)
                setInt(R.id.notification_btn_accept, "setTextColor", acceptColor)
                setOnClickPendingIntent(R.id.notification_btn_decline, declinePendingIntent)
                setOnClickPendingIntent(R.id.notification_btn_accept, answerPendingIntent)
            }
            builder.setCustomContentView(customView).setCustomHeadsUpContentView(customView)
        } catch (e: Exception) {
            Log.e(TAG, "Custom notification view failed, using default", e)
            builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, getString(R.string.incoming_call_decline), declinePendingIntent)
                .addAction(android.R.drawable.ic_menu_call, getString(R.string.incoming_call_accept), answerPendingIntent)
        }

        notificationManager.notify(NOTIFICATION_ID_INCOMING_CALL, builder.build())
        Log.d(TAG, "FCM: notification with full-screen intent posted")
    }

    companion object {
        private const val TAG = "LiviFCM"
        const val CHANNEL_ID_CALLS = "livi_incoming_call"
        const val NOTIFICATION_ID_INCOMING_CALL = 1001
        const val ACTION_CALL_CANCELED = "com.kolt12max.livi.CALL_CANCELED"
        const val EXTRA_CALL_ID = "callId"
    }
}
