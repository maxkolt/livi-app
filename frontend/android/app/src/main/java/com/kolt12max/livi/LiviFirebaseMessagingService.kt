package com.kolt12max.livi

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.widget.RemoteViews
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
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
        val keysStr = data.keys.joinToString(", ")
        val typeRaw = data["type"]
        val callIdRaw = data["callId"]
        Log.e(TAG, "FCM onMessageReceived keys=[$keysStr] type=$typeRaw callId=$callIdRaw")

        var type = typeRaw
        var callId = callIdRaw
        var from = data["from"] ?: data["fromUserId"]
        var fromNick = data["fromNick"] ?: ""

        // Expo присылает пуши с keys=[projectId, experienceId, scopeKey, body] — type/callId внутри body
        if (data["body"] != null) {
            try {
                val body = JSONObject(data["body"]!!)
                val bodyType = body.optString("type", "").takeIf { it.isNotEmpty() }
                val bodyCallId = body.optString("callId", "").takeIf { it.isNotEmpty() }
                if (bodyType != null || bodyCallId != null) {
                    if (type == null) type = bodyType
                    if (callId == null) callId = bodyCallId
                    if (from == null) from = body.optString("from", "").takeIf { it.isNotEmpty() } ?: body.optString("fromUserId", "").takeIf { it.isNotEmpty() }
                    if (fromNick.isEmpty()) fromNick = body.optString("fromNick", "")
                }
            } catch (e: Exception) {
                Log.w(TAG, "FCM parse body failed", e)
            }
        }

        val typeNorm = type?.trim()?.lowercase() ?: ""

        if (typeNorm == "call" && callId != null && from != null) {
            if (MainActivity.isInForeground) {
                Log.d(TAG, "FCM call push: app in foreground, skip notification (in-app UI will handle)")
                return
            }
            // Всегда показываем нативный полноэкранный экран входящего: домашний экран, блокировка, приложение в фоне/закрыто
            if (isDeviceLocked()) {
                LiviAppModule.tryStartCallKeepHeadlessTask(callId, from, fromNick) { _ -> }
            }
            val activityIntent = buildIncomingCallActivityIntent(this, callId, from, fromNick)
            try {
                activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(activityIntent)
                Log.d(TAG, "FCM call push: activity launch (incoming call screen)")
            } catch (e: Exception) {
                Log.w(TAG, "FCM call push: startActivity failed", e)
            }
            ensureCallChannel(this)
            startIncomingCallForegroundService(callId, from, fromNick, headsUpOnly = false)
            return
        }
        if (typeNorm == "call_canceled" && callId != null) {
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
        // Абонент принял вызов — закрыть нативный экран исходящего, вывести MainActivity, сохранить callId для JS (call:getAccepted → call:accepted → переход на VideoCall).
        if (typeNorm == "call_accepted" && callId != null) {
            Log.e(TAG, "FCM call_accepted received: closing outgoing, starting MainActivity callId=$callId")
            // 1) Broadcast — если OutgoingCallActivity на экране, закроется по нему
            val closeOutgoing = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeOutgoing)
            LiviOutgoingCallService.stop(this)
            LiviAppModule.setPendingCallAcceptedCallId(callId)
            // 2) Запуск OutgoingCallActivity с EXTRA_CLOSE_IMMEDIATELY — если broadcast не дошёл (приложение в фоне), активность откроется и сразу finish()
            val closeActivityIntent = Intent(this, OutgoingCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            try {
                startActivity(closeActivityIntent)
            } catch (e: Exception) {
                Log.w(TAG, "FCM call_accepted: startActivity OutgoingCallActivity(close) failed", e)
            }
            val mainIntent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_PENDING_CALL_ACCEPTED_CALL_ID, callId)
            }
            try {
                startActivity(mainIntent)
                Log.d(TAG, "FCM call_accepted: closed outgoing, brought MainActivity to front callId=$callId")
            } catch (e: Exception) {
                Log.w(TAG, "FCM call_accepted: startActivity MainActivity failed", e)
            }
            return
        }
        // Получатель отклонил — закрыть нативный экран исходящего у звонящего (сокет в фоне может быть отключён).
        if (typeNorm == "call_declined" && callId != null) {
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeIntent)
            val activityIntent = Intent(this, OutgoingCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            try { startActivity(activityIntent) } catch (e: Exception) { Log.w(TAG, "FCM call_declined: startActivity failed", e) }
            Log.d(TAG, "FCM call_declined: broadcast + startActivity(close) callId=$callId")
            return
        }
        // Звонок завершён: снять уведомление входящего, закрыть экран исходящего. «Пропущенный вызов» только если разговор не был принят (таймаут/отмена), не после завершения с видеочата/PiP.
        if (typeNorm == "call_ended" && callId != null) {
            EndedCallIds.add(this, callId)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
            val cancelIntent = Intent(ACTION_CALL_CANCELED).apply {
                setPackage(packageName)
                putExtra(EXTRA_CALL_ID, callId)
            }
            sendBroadcast(cancelIntent)
            val endedFromActive = "true" == data["endedFromActive"]
            if (!endedFromActive) {
                var fromNickEnded = data["fromNick"] ?: ""
                if (fromNickEnded.isEmpty() && data["body"] != null) {
                    try {
                        fromNickEnded = org.json.JSONObject(data["body"]!!).optString("fromNick", "")
                    } catch (_: Exception) {}
                }
                showMissedCallNotification(callId, from ?: "", fromNickEnded)
            }
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeIntent)
            val activityIntent = Intent(this, OutgoingCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            try { startActivity(activityIntent) } catch (e: Exception) { Log.w(TAG, "FCM call_ended: startActivity failed", e) }
            Log.d(TAG, "FCM call_ended: incoming canceled, missed=${!endedFromActive}, outgoing closed callId=$callId")
            return
        }
        Log.w(TAG, "FCM unhandled: typeNorm=$typeNorm type=$type callId=$callId keys=[$keysStr] → forwarding to Expo")
        super.onMessageReceived(remoteMessage)
    }

    private fun isDeviceLocked(): Boolean {
        val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            @Suppress("DEPRECATION")
            km.isKeyguardLocked
        } else {
            false
        }
    }

    private fun showMissedCallNotification(callId: String, fromUserId: String, fromNick: String) {
        ensureMissedCallChannel(this)
        LiviAppModule.addPendingMissedCall(this, fromUserId)
        val count = LiviAppModule.incrementMissedCountForUser(this, fromUserId)
        val title = getString(R.string.missed_call_title)
        val body = when {
            count > 1 && fromNick.isNotEmpty() -> getString(R.string.missed_call_from_count, count, fromNick)
            count > 1 -> getString(R.string.missed_call_from_count, count, getString(R.string.incoming_call_title))
            fromNick.isNotEmpty() -> getString(R.string.missed_call_from, fromNick)
            else -> getString(R.string.incoming_call_title)
        }
        val smallIconRes = resources.getIdentifier("ic_launcher", "mipmap", packageName).takeIf { it != 0 }
            ?: android.R.drawable.ic_menu_call
        val contentIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val contentPending = PendingIntent.getActivity(
            this,
            0,
            contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val deleteIntent = Intent(LiviAppModule.ACTION_MISSED_CALL_DISMISSED).apply {
            setPackage(packageName)
            putExtra(LiviAppModule.EXTRA_USER_ID, fromUserId)
        }
        val deletePending = PendingIntent.getBroadcast(
            this,
            fromUserId.hashCode() and 0x7FFF,
            deleteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID_MISSED_CALL)
            .setSmallIcon(smallIconRes)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(contentPending)
            .setDeleteIntent(deletePending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notificationId = LiviAppModule.getMissedNotificationIdForUser(fromUserId)
        nm.notify(notificationId, notification)
    }

    private fun startIncomingCallForegroundService(callId: String, from: String, fromNick: String, headsUpOnly: Boolean = false) {
        val serviceIntent = Intent(this, IncomingCallForegroundService::class.java).apply {
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(IncomingCallForegroundService.EXTRA_FROM, from)
            putExtra(IncomingCallForegroundService.EXTRA_FROM_NICK, fromNick)
            putExtra(IncomingCallForegroundService.EXTRA_HEADS_UP_ONLY, headsUpOnly)
        }
        if (!headsUpOnly) {
            val activityIntent = buildIncomingCallActivityIntent(this, callId, from, fromNick).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "startForegroundService failed, launching activity directly", e)
                startActivity(activityIntent)
            }
        } else {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "startForegroundService (headsUpOnly) failed", e)
            }
        }
    }

    companion object {
        private const val TAG = "LiviFCM"
        /** ID канала: HIGH чтобы full-screen intent срабатывал (нативный экран поверх домашнего). */
        const val CHANNEL_ID_CALLS = "livi_incoming_call_v3"
        const val NOTIFICATION_ID_INCOMING_CALL = 1001
        private const val CHANNEL_ID_MISSED_CALL = "missed_call"
        const val ACTION_CALL_CANCELED = "com.kolt12max.livi.CALL_CANCELED"
        const val EXTRA_CALL_ID = "callId"

        /** Канал входящих звонков: HIGH — чтобы full-screen intent сработал и нативный экран показался поверх домашнего. */
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

        /** Канал «Пропущенный вызов» — без звука/вибрации. */
        @JvmStatic
        fun ensureMissedCallChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID_MISSED_CALL,
                    context.getString(R.string.missed_call_title),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    setSound(null, null)
                    setVibrationPattern(longArrayOf(0))
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
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

        /** Уведомление входящего звонка: в свёрнутом виде в шторке — компактная строка с кнопками (Отклонить/Принять),
         * в развёрнутом — полный layout с текстом «Входящий видеозвонок». Тап по области (имя, время) → нативный экран.
         * Тап по кнопкам → Принять/Отклонить. Full-screen intent для нативного экрана по возможности. */
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

            val declineIntent = Intent(DeclineCallReceiver.ACTION_DECLINE_CALL).apply {
                setPackage(context.packageName)
                putExtra(DeclineCallReceiver.EXTRA_CALL_ID, callId)
            }
            val declinePending = PendingIntent.getBroadcast(
                context,
                REQUEST_DECLINE,
                declineIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val answerUri = "livi://answer-call?callId=${Uri.encode(callId)}&from=${Uri.encode(from)}&fromNick=${URLEncoder.encode(fromNick, StandardCharsets.UTF_8.name())}"
            val answerIntent = Intent(Intent.ACTION_VIEW, Uri.parse(answerUri)).apply {
                setClassName(context, "com.kolt12max.livi.MainActivity")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            }
            val answerPending = PendingIntent.getActivity(
                context,
                REQUEST_ACCEPT,
                answerIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val timeString = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
            val remoteViewsCompact = RemoteViews(context.packageName, R.layout.notification_incoming_call_compact).apply {
                setTextViewText(R.id.notification_title, title)
                setTextViewText(R.id.notification_text, subtitle)
                setTextViewText(R.id.notification_time, timeString)
                setOnClickPendingIntent(R.id.notification_content_area, fullScreenPendingIntent)
                setOnClickPendingIntent(R.id.notification_btn_decline, declinePending)
                setOnClickPendingIntent(R.id.notification_btn_accept, answerPending)
            }
            val remoteViewsBig = RemoteViews(context.packageName, R.layout.notification_incoming_call).apply {
                setImageViewResource(R.id.notification_logo, smallIconRes)
                setTextViewText(R.id.notification_title, title)
                setTextViewText(R.id.notification_text, subtitle)
                setTextViewText(R.id.notification_time, timeString)
                setOnClickPendingIntent(R.id.notification_content_area, fullScreenPendingIntent)
                setOnClickPendingIntent(R.id.notification_btn_decline, declinePending)
                setOnClickPendingIntent(R.id.notification_btn_accept, answerPending)
            }

            val noOpIntent = Intent("com.kolt12max.livi.NOTIFICATION_EXPAND_NOOP").apply {
                setPackage(context.packageName)
            }
            val noOpPendingIntent = PendingIntent.getBroadcast(
                context,
                REQUEST_NOOP,
                noOpIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setCustomContentView(remoteViewsCompact)
                .setCustomBigContentView(remoteViewsBig)
                .setContentIntent(noOpPendingIntent)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(20_000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setVibrate(longArrayOf(0, 500, 200, 500))
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.incoming_call_decline), declinePending)
                .addAction(android.R.drawable.ic_menu_call, context.getString(R.string.incoming_call_accept), answerPending)
                .build()
        }

        private const val REQUEST_ACCEPT = 2001
        private const val REQUEST_DECLINE = 2002
        private const val REQUEST_CONTENT = 2003
        private const val REQUEST_NOOP = 2004

        /** Heads-up уведомление с кнопками Принять/Отклонить; всплывает один раз и исчезает в шторку. */
        @JvmStatic
        fun buildIncomingCallNotificationHeadsUpOnly(context: Context, callId: String, from: String, fromNick: String): Notification {
            val title = if (fromNick.isNotEmpty()) fromNick else context.getString(R.string.incoming_call_title)
            val subtitle = context.getString(R.string.incoming_call_title)
            val smallIconRes = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName).takeIf { it != 0 }
                ?: android.R.drawable.ic_menu_call

            val contentIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val contentPending = PendingIntent.getActivity(
                context,
                REQUEST_CONTENT,
                contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val declineIntent = Intent(DeclineCallReceiver.ACTION_DECLINE_CALL).apply {
                setPackage(context.packageName)
                putExtra(DeclineCallReceiver.EXTRA_CALL_ID, callId)
            }
            val declinePending = PendingIntent.getBroadcast(
                context,
                REQUEST_DECLINE,
                declineIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val answerUri = "livi://answer-call?callId=${Uri.encode(callId)}&from=${Uri.encode(from)}&fromNick=${URLEncoder.encode(fromNick, StandardCharsets.UTF_8.name())}"
            val answerIntent = Intent(Intent.ACTION_VIEW, Uri.parse(answerUri)).apply {
                setClassName(context, "com.kolt12max.livi.MainActivity")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            }
            val answerPending = PendingIntent.getActivity(
                context,
                REQUEST_ACCEPT,
                answerIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val timeString = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
            val remoteViews = RemoteViews(context.packageName, R.layout.notification_incoming_call).apply {
                setImageViewResource(R.id.notification_logo, smallIconRes)
                setTextViewText(R.id.notification_title, title)
                setTextViewText(R.id.notification_text, subtitle)
                setTextViewText(R.id.notification_time, timeString)
                setOnClickPendingIntent(R.id.notification_btn_decline, declinePending)
                setOnClickPendingIntent(R.id.notification_btn_accept, answerPending)
            }

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setCustomContentView(remoteViews)
                .setCustomBigContentView(remoteViews)
                .setContentIntent(contentPending)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setVibrate(longArrayOf(0, 500, 200, 500))
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.incoming_call_decline), declinePending)
                .addAction(android.R.drawable.ic_menu_call, context.getString(R.string.incoming_call_accept), answerPending)
                .build()
        }
    }
}
