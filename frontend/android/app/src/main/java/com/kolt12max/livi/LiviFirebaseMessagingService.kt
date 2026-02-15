package com.kolt12max.livi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
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
            // Опционально: ConnectionService (CallKeep) — на части устройств покажет системный экран звонка
            LiviAppModule.tryStartCallKeepHeadlessTask(callId, from, fromNick) { _ -> }
            // Всегда показываем свой экран: активность + уведомление с full-screen intent + foreground-сервис.
            // Без этого на многих устройствах вне приложения и на заблокированном экране ничего не видно.
            val activityIntent = buildIncomingCallActivityIntent(this, callId, from, fromNick)
            try {
                activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(activityIntent)
                Log.d(TAG, "FCM call push: activity launch attempted")
            } catch (e: Exception) {
                Log.w(TAG, "FCM call push: startActivity failed", e)
            }
            ensureCallChannel(this)
            val notification = buildIncomingCallNotification(this, callId, from, fromNick)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID_INCOMING_CALL, notification)
            Log.d(TAG, "FCM call push: notification posted (full-screen intent), starting IncomingCallForegroundService")
            startIncomingCallForegroundService(callId, from, fromNick)
            return
        }
        if (type == "call_canceled" && callId != null) {
            EndedCallIds.add(this, callId)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
            val intent = Intent(ACTION_CALL_CANCELED).apply {
                setPackage(packageName)
                putExtra(EXTRA_CALL_ID, callId)
            }
            sendBroadcast(intent)
            // Если приложение в фоне/убито, broadcast не дойдёт — запускаем активность с флагом «только закрыть»
            val activityIntent = Intent(this, IncomingCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(IncomingCallActivity.EXTRA_JUST_CLOSE, true)
                putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
            }
            try {
                startActivity(activityIntent)
            } catch (e: Exception) {
                Log.w(TAG, "FCM call_canceled: startActivity close IncomingCall failed", e)
            }
            Log.d(TAG, "FCM call_canceled: ended id stored, notification canceled, broadcast + startActivity(close) callId=$callId")
            return
        }
        // Получатель отклонил — закрыть нативный экран исходящего у звонящего (сокет в фоне может быть отключён).
        if (type == "call_declined" && callId != null) {
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeIntent)
            // Если приложение в фоне/убито, broadcast не дойдёт — запускаем активность с флагом «сразу закрыть»
            val activityIntent = Intent(this, OutgoingCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            try {
                startActivity(activityIntent)
            } catch (e: Exception) {
                Log.w(TAG, "FCM call_declined: startActivity close OutgoingCall failed", e)
            }
            Log.d(TAG, "FCM call_declined: broadcast + startActivity(close) callId=$callId")
            return
        }
        super.onMessageReceived(remoteMessage)
    }

    private fun startIncomingCallForegroundService(callId: String, from: String, fromNick: String) {
        val activityIntent = buildIncomingCallActivityIntent(this, callId, from, fromNick).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val serviceIntent = Intent(this, IncomingCallForegroundService::class.java).apply {
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(IncomingCallForegroundService.EXTRA_FROM, from)
            putExtra(IncomingCallForegroundService.EXTRA_FROM_NICK, fromNick)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        } catch (e: Exception) {
            // Android 12+: запуск foreground из фона может быть запрещён — сразу открываем полноэкранную активность
            Log.w(TAG, "startForegroundService failed, launching activity directly", e)
            startActivity(activityIntent)
        }
    }

    companion object {
        private const val TAG = "LiviFCM"
        const val CHANNEL_ID_CALLS = "livi_incoming_call"
        const val NOTIFICATION_ID_INCOMING_CALL = 1001
        const val ACTION_CALL_CANCELED = "com.kolt12max.livi.CALL_CANCELED"
        const val EXTRA_CALL_ID = "callId"

        /** Создаёт канал уведомлений для входящих звонков. IMPORTANCE_HIGH/MAX для приоритета full-screen. */
        @JvmStatic
        fun ensureCallChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID_CALLS,
                    context.getString(R.string.incoming_call_title),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    setSound(null, null)
                    setVibrationPattern(longArrayOf(0, 500, 200, 500))
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                    setDescription(context.getString(R.string.incoming_call_title))
                }
                nm.createNotificationChannel(channel)
            }
        }

        /** Intent для IncomingCallActivity (поверх блокировки и домашнего экрана). */
        @JvmStatic
        fun buildIncomingCallActivityIntent(context: Context, callId: String, from: String, fromNick: String): Intent {
            return Intent(context, IncomingCallActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                        Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED or
                        Intent.FLAG_ACTIVITY_NO_USER_ACTION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                        0x00080000 or  // FLAG_ACTIVITY_SHOW_WHEN_LOCKED (API 27)
                        0x00200000    // FLAG_ACTIVITY_TURN_SCREEN_ON (API 27)
                )
                putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
                putExtra(IncomingCallActivity.EXTRA_FROM, from)
                putExtra(IncomingCallActivity.EXTRA_FROM_NICK, fromNick)
            }
        }

        /** Собирает уведомление входящего звонка с full-screen intent (для foreground-сервиса). */
        @JvmStatic
        fun buildIncomingCallNotification(context: Context, callId: String, from: String, fromNick: String): Notification {
            val fullScreenIntent = buildIncomingCallActivityIntent(context, callId, from, fromNick)
            val fullScreenPendingIntent = PendingIntent.getActivity(
                context,
                NOTIFICATION_ID_INCOMING_CALL,
                fullScreenIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val title = if (fromNick.isNotEmpty()) fromNick else context.getString(R.string.incoming_call_title)
            val subtitle = context.getString(R.string.incoming_call_title)
            val smallIconRes = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName).takeIf { it != 0 }
                ?: android.R.drawable.ic_menu_call
            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(fullScreenPendingIntent)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(45_000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setVibrate(longArrayOf(0, 500, 200, 500))
                .build()
        }
    }
}
