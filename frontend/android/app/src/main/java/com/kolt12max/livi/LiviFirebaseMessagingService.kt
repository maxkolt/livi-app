package com.kolt12max.livi

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.ActivityManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import io.wazo.callkeep.RNCallKeepBackgroundMessagingService
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
        var bodyEndedFromActive: String? = null

        // Expo присылает пуши с keys=[projectId, experienceId, scopeKey, body] — type/callId/endedFromActive внутри body
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
                val fromBody = body.optString("endedFromActive", "").takeIf { it.isNotEmpty() }
                    ?: if (body.optBoolean("endedFromActive", false)) "true" else null
                bodyEndedFromActive = fromBody
            } catch (e: Exception) {
                Log.w(TAG, "FCM parse body failed", e)
            }
        }

        val typeNorm = type?.trim()?.lowercase() ?: ""

        if (typeNorm == "call" && callId != null && from != null) {
            val keyguardLocked = try {
                (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked == true
            } catch (_: Exception) { false }
            val isInteractive = try {
                (getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive == true
            } catch (_: Exception) { true }
            Log.e(TAG, "[INCOMING_CALL] FCM call push: callId=$callId from=$from keyguardLocked=$keyguardLocked isInteractive=$isInteractive SDK=${Build.VERSION.SDK_INT} IncomingCallFg=${IncomingCallActivity.isInForeground} MainFg=${MainActivity.isInForeground}")
            if (IncomingCallActivity.isInForeground) {
                Log.w(TAG, "[INCOMING_CALL] Skip: IncomingCallActivity already visible")
                return
            }
            // При заблокированном/выключенном экране всегда показываем нативный экран — сокет может быть отключён.
            val screenLockedOrOff = keyguardLocked || !isInteractive
            if (MainActivity.isInForeground && !screenLockedOrOff) {
                Log.w(TAG, "[INCOMING_CALL] Skip: app in foreground and screen unlocked (socket will handle)")
                return
            }
            // Wake lock: даём процессу время запустить FGS и показать full-screen intent (особенно при убитом приложении).
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            val wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "livi:incoming_call")?.apply {
                try { acquire(10 * 60 * 1000L) } catch (_: Exception) {}
            }
            Handler(Looper.getMainLooper()).postDelayed({
                try { wakeLock?.release() } catch (_: Exception) {}
            }, 8000L)
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancelAll()
            } catch (_: Exception) {}
            // Не запускаем headless для входящего: показ и рингтон идут через IncomingCallForegroundService (full-screen + ringtone сразу).
            // Headless давал задержку ~5 сек и дублирование UI; один путь — FCM → FGS → full-screen intent + LiviAppModule.startIncomingCallRingtoneAndVibrationStatic.
            Log.d(TAG, "[INCOMING_CALL] Using FGS-only path (no headless) for immediate full-screen + ringtone")
            // Всегда показываем входящий полноэкранно с рингтоном/вибрацией: один путь без задержки headless (~5 сек).
            // Full-screen intent + рингтон в FGS — сразу; не переключаемся на headsUpOnly при разблокированном экране.
            ensureCallChannel(this)
            startIncomingCallForegroundService(
                callId,
                from,
                fromNick,
                headsUpOnly = false,
                silentNotification = false
            )
            Log.e(TAG, "[INCOMING_CALL] IncomingCallForegroundService started (full-screen + ringtone) keyguardLocked=$keyguardLocked isInteractive=$isInteractive (if FSI denied, check logcat for FSI_REQUESTED_BUT_DENIED or BAL_BLOCK)")
            return
        }
        if (typeNorm == "call_canceled" && callId != null) {
            EndedCallIds.add(this, callId)
            LiviOngoingCallHelper.clearOngoingCall(applicationContext)
            LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
            val intent = Intent(ACTION_CALL_CANCELED).apply {
                setPackage(packageName)
                putExtra(EXTRA_CALL_ID, callId)
            }
            sendBroadcast(intent)
            // Инициатор отменил — показываем «пропущенный вызов» и счётчик (fromUserId/fromNick в data или body)
            var fromCanceled = data["fromUserId"] ?: data["from"]
            var fromNickCanceled = data["fromNick"] ?: ""
            if (fromCanceled == null && data["body"] != null) {
                try {
                    val body = JSONObject(data["body"]!!)
                    fromCanceled = body.optString("fromUserId", "").takeIf { it.isNotEmpty() }
                        ?: body.optString("from", "").takeIf { it.isNotEmpty() }
                    if (fromNickCanceled.isEmpty()) fromNickCanceled = body.optString("fromNick", "")
                } catch (_: Exception) {}
            }
            if (fromCanceled != null && fromCanceled.toString().isNotEmpty()) {
                if (!LiviAppModule.wasMissedShownForCallId(this, callId)) {
                    LiviAppModule.markMissedShownForCallId(this, callId)
                    showMissedCallNotification(callId, fromCanceled.toString(), fromNickCanceled)
                }
            }
            // ВАЖНО: не запускаем IncomingCallActivity повторно ради "just_close".
            // Если экран входящего существует, broadcast ACTION_CALL_CANCELED его уже закроет.
            // Если процесса/активности нет, закрывать уже нечего, а повторный startActivity
            // после Expo body-push даёт заметное мерцание (экран успевает открыться и сразу закрыться).
            val shouldLaunchCloseActivity = false
            Log.d(
                TAG,
                "FCM call_canceled: ended id stored, incoming canceled, missed shown, closeFallback=$shouldLaunchCloseActivity callId=$callId"
            )
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
            // 2) Только MainActivity на передний план (без startActivity(OutgoingCallActivity close) — иначе два startActivity сбрасывают стек и в dev показывается экран «Development servers» вместо VideoCall).
            if (!isAppProcessForeground()) {
                val mainIntent = Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra(MainActivity.EXTRA_PENDING_CALL_ACCEPTED_CALL_ID, callId)
                }
                try {
                    startActivity(mainIntent)
                    Log.d(TAG, "FCM call_accepted: brought MainActivity to front callId=$callId")
                } catch (e: Exception) {
                    Log.w(TAG, "FCM call_accepted: startActivity MainActivity failed", e)
                }
            } else {
                Log.d(TAG, "FCM call_accepted: app in foreground, broadcast only (socket path already closed) callId=$callId")
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
            // В активном процессе (когда OutgoingCallActivity уже на экране) достаточно broadcast.
            // Принудительный startActivity(close) в этом сценарии даёт двойное закрытие/мерцание.
            if (!isAppProcessForeground()) {
                val activityIntent = Intent(this, OutgoingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                }
                try { startActivity(activityIntent) } catch (e: Exception) { Log.w(TAG, "FCM call_declined: startActivity failed", e) }
                Log.d(TAG, "FCM call_declined: broadcast + fallback startActivity(close) callId=$callId")
            } else {
                Log.d(TAG, "FCM call_declined: broadcast only (foreground) callId=$callId")
            }
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
            val endedFromActiveRaw = data["endedFromActive"] ?: bodyEndedFromActive ?: ""
            val endedFromActive = "true" == endedFromActiveRaw
            if (!endedFromActive) {
                if (!LiviAppModule.wasMissedShownForCallId(this, callId)) {
                    LiviAppModule.markMissedShownForCallId(this, callId)
                    var fromNickEnded = data["fromNick"] ?: ""
                    if (fromNickEnded.isEmpty() && data["body"] != null) {
                        try {
                            fromNickEnded = org.json.JSONObject(data["body"]!!).optString("fromNick", "")
                        } catch (_: Exception) {}
                    }
                    showMissedCallNotification(callId, from ?: "", fromNickEnded)
                }
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
            // КРИТИЧНО: Когда звонок завершён из PiP (endedFromActive), собеседник может быть в системном PiP с отключённым сокетом.
            // Пуш доходит сразу — закрываем его PiP broadcast'ом, чтобы окно закрылось без задержки 5–7 сек (LiveKit).
            if (endedFromActive) {
                val closePipIntent = Intent(ACTION_CLOSE_PIP_CALL_ENDED).apply { setPackage(packageName) }
                sendBroadcast(closePipIntent)
                Log.d(TAG, "FCM call_ended: sent ACTION_CLOSE_PIP_CALL_ENDED (endedFromActive) to close partner PiP immediately")
            }
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
        LiviAppModule.saveMissedCallNick(this, fromUserId, fromNick)
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
            putExtra(MainActivity.EXTRA_OPEN_TAB_FRIENDS, true)
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
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notificationId = LiviAppModule.getMissedNotificationIdForUser(fromUserId)
        nm.notify(notificationId, notification)
    }

    private fun startIncomingCallForegroundService(
        callId: String,
        from: String,
        fromNick: String,
        headsUpOnly: Boolean = false,
        silentNotification: Boolean = false
    ) {
        val serviceIntent = Intent(this, IncomingCallForegroundService::class.java).apply {
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(IncomingCallForegroundService.EXTRA_FROM, from)
            putExtra(IncomingCallForegroundService.EXTRA_FROM_NICK, fromNick)
            putExtra(IncomingCallForegroundService.EXTRA_HEADS_UP_ONLY, headsUpOnly)
            putExtra(IncomingCallForegroundService.EXTRA_SILENT_NOTIFICATION, silentNotification)
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
                // В "тихом" режиме не открываем IncomingCallActivity напрямую (иначе получится popup).
                // Для full-screen режима (locked) — fallback на прямой запуск activity оставляем.
                if (!silentNotification) {
                    Log.w(TAG, "startForegroundService failed, launching activity directly", e)
                    startActivity(activityIntent)
                } else {
                    Log.w(TAG, "startForegroundService failed (silent mode), skipping direct activity launch", e)
                }
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
        const val CHANNEL_ID_CALLS = "livi_incoming_call_v4"
        /** Канал входящего без звука/вибрации уведомления: звук и вибрация запускаются из кода (системная мелодия звонка). */
        const val CHANNEL_ID_CALLS_VISUAL = "livi_incoming_call_visual_v1"
        /** Тихий канал для входящего: без heads-up, только иконка/шторка (когда телефон разблокирован). */
        const val CHANNEL_ID_CALLS_SILENT = "livi_incoming_call_silent_v1"
        const val NOTIFICATION_ID_INCOMING_CALL = 1001
        private const val CHANNEL_ID_MISSED_CALL = "missed_call"
        const val ACTION_CALL_CANCELED = "com.kolt12max.livi.CALL_CANCELED"
        /** Broadcast: закрыть системный PiP сразу при пуше call_ended (endedFromActive). Собеседник в PiP не получает call:ended по сокету — пуш доходит, MainActivity закрывает PiP. */
        const val ACTION_CLOSE_PIP_CALL_ENDED = "com.kolt12max.livi.CLOSE_PIP_CALL_ENDED"
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
                    val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                    val attrs = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                    setSound(ringtoneUri, attrs)
                    enableVibration(true)
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                    setDescription(context.getString(R.string.incoming_call_title))
                }
                nm.createNotificationChannel(channel)

                // Визуальный канал: HIGH для heads-up/full-screen, без звука и вибрации уведомления — мелодия и вибрация из кода (системный звонок).
                val visualChannel = NotificationChannel(
                    CHANNEL_ID_CALLS_VISUAL,
                    context.getString(R.string.incoming_call_title),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    setSound(null, null)
                    enableVibration(false)
                    setVibrationPattern(longArrayOf(0))
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                    setDescription(context.getString(R.string.incoming_call_title))
                }
                nm.createNotificationChannel(visualChannel)

                // Тихий канал: без heads-up. Используем когда телефон разблокирован, чтобы не мешать поверх других приложений.
                val silentChannel = NotificationChannel(
                    CHANNEL_ID_CALLS_SILENT,
                    context.getString(R.string.incoming_call_title),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    setSound(null, null)
                    setVibrationPattern(longArrayOf(0))
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                    setDescription(context.getString(R.string.incoming_call_title))
                }
                nm.createNotificationChannel(silentChannel)
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

        /** Обновить текст уведомления «пропущенный вызов» по счётчику из JS (чтобы в шторке было то же число). */
        @JvmStatic
        fun updateMissedCallNotification(context: Context, userId: String, count: Int) {
            if (userId.isBlank() || count < 0) return
            ensureMissedCallChannel(context)
            val fromNick = LiviAppModule.getMissedCallNick(context, userId)
            val title = context.getString(R.string.missed_call_title)
            val body = when {
                count > 1 && fromNick.isNotEmpty() -> context.getString(R.string.missed_call_from_count, count, fromNick)
                count > 1 -> context.getString(R.string.missed_call_from_count, count, context.getString(R.string.incoming_call_title))
                fromNick.isNotEmpty() -> context.getString(R.string.missed_call_from, fromNick)
                else -> context.getString(R.string.incoming_call_title)
            }
            val smallIconRes = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName).takeIf { it != 0 }
                ?: android.R.drawable.ic_menu_call
            val contentIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_OPEN_TAB_FRIENDS, true)
            }
            val contentPending = PendingIntent.getActivity(
                context, 0, contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val deleteIntent = Intent(LiviAppModule.ACTION_MISSED_CALL_DISMISSED).apply {
                setPackage(context.packageName)
                putExtra(LiviAppModule.EXTRA_USER_ID, userId)
            }
            val deletePending = PendingIntent.getBroadcast(
                context, userId.hashCode() and 0x7FFF, deleteIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_ID_MISSED_CALL)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(contentPending)
                .setDeleteIntent(deletePending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(LiviAppModule.getMissedNotificationIdForUser(userId), notification)
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

        /** Уведомление входящего звонка: только системный вид (без серой карточки).
         * Full-screen intent открывает IncomingCallActivity; при открытии экрана уведомление снимается. */
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

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS_VISUAL)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(fullScreenPendingIntent)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(20_000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.incoming_call_decline), declinePending)
                .addAction(android.R.drawable.ic_menu_call, context.getString(R.string.incoming_call_accept), answerPending)
                .build()
        }

        private const val REQUEST_ACCEPT = 2001
        private const val REQUEST_DECLINE = 2002
        private const val REQUEST_CONTENT = 2003

        /** Heads-up уведомление без серой карточки: системный вид, кнопки Принять/Отклонить. */
        @JvmStatic
        fun buildIncomingCallNotificationHeadsUpOnly(context: Context, callId: String, from: String, fromNick: String): Notification {
            val title = if (fromNick.isNotEmpty()) fromNick else context.getString(R.string.incoming_call_title)
            val subtitle = context.getString(R.string.incoming_call_title)
            val smallIconRes = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName).takeIf { it != 0 }
                ?: android.R.drawable.ic_menu_call

            // Тап по уведомлению в шторке открывает нативный IncomingCallActivity (если звонок ещё активен).
            val contentIntent = buildIncomingCallActivityIntent(context, callId, from, fromNick)
            val contentPending = PendingIntent.getActivity(
                context,
                NOTIFICATION_ID_INCOMING_CALL,
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

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS_VISUAL)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(contentPending)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(false)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(20_000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.incoming_call_decline), declinePending)
                .addAction(android.R.drawable.ic_menu_call, context.getString(R.string.incoming_call_accept), answerPending)
                .build()
        }

        /** Тихое уведомление входящего: без heads-up, только иконка в статус-баре и запись в шторке (кнопки Принять/Отклонить сохраняем). */
        @JvmStatic
        fun buildIncomingCallNotificationSilent(context: Context, callId: String, from: String, fromNick: String): Notification {
            val title = if (fromNick.isNotEmpty()) fromNick else context.getString(R.string.incoming_call_title)
            val subtitle = context.getString(R.string.incoming_call_title)
            val smallIconRes = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName).takeIf { it != 0 }
                ?: android.R.drawable.ic_menu_call

            // Тап по уведомлению в шторке открывает нативный IncomingCallActivity (если звонок ещё активен).
            val contentIntent = buildIncomingCallActivityIntent(context, callId, from, fromNick)
            val contentPending = PendingIntent.getActivity(
                context,
                NOTIFICATION_ID_INCOMING_CALL,
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

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS_SILENT)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(contentPending)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                // Не закрываем автоматически, но позволяем пользователю скрыть уведомление вручную.
                .setOngoing(false)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(20_000)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.incoming_call_decline), declinePending)
                .addAction(android.R.drawable.ic_menu_call, context.getString(R.string.incoming_call_accept), answerPending)
                .build()
        }
    }

    private fun isScreenInteractive(): Boolean {
        return try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isInteractive
        } catch (_: Exception) {
            true
        }
    }

    private fun isAppProcessForeground(): Boolean {
        return try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
            val myPid = android.os.Process.myPid()
            val proc = am.runningAppProcesses?.firstOrNull { it.pid == myPid }
            proc?.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        } catch (_: Exception) {
            false
        }
    }
}
