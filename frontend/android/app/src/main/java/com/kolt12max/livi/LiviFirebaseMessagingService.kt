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
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import io.wazo.callkeep.RNCallKeepBackgroundMessagingService
import org.json.JSONObject

/**
 * Единственный FCM-сервис приложения: расширяет Expo и перехватывает пуши о звонке.
 * Для type=call: сразу startActivity(IncomingCallActivity) + FGS с уведомлением в шторке (без heads-up поверх экрана); тап по уведомлению снова открывает экран.
 * Остальные пуши передаёт в Expo (super.onMessageReceived).
 */
class LiviFirebaseMessagingService : ExpoFirebaseMessagingService() {

    private fun vLog(msg: String) {
        if (BuildConfig.ENABLE_FCM_VERBOSE_LOG) Log.d(TAG, msg)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data ?: emptyMap()
        val keysStr = data.keys.joinToString(", ")
        val typeRaw = data["type"]
        val callIdRaw = data["callId"]
        vLog("FCM onMessageReceived keys=[$keysStr] type=$typeRaw callId=$callIdRaw")

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
        vLog("FCM parsed typeNorm=$typeNorm callId=$callId")

        if (typeNorm == "call" && callId != null && from != null) {
            LiviAppModule.saveIncomingCallMeta(this, callId, from, fromNick)
            val hasVideoCall = data["media"]?.trim()?.lowercase() == "video"
            // Пуш «call» пришёл с задержкой (устройство было офлайн): показываем только «Пропущенный вызов», не полноэкранный входящий.
            val CALL_RING_TIMEOUT_MS = 27_000L
            val MIN_REMAINING_WINDOW_TO_OPEN_UI_MS = 2_000L
            var callTs: Long? = data["ts"]?.toLongOrNull()
            var callExpiresAtMs: Long? = data["expiresAt"]?.toLongOrNull()
            if (callTs == null && data["body"] != null) {
                try {
                    val body = JSONObject(data["body"]!!)
                    callTs = body.optString("ts", "").takeIf { it.isNotEmpty() }?.toLongOrNull()
                    if (callExpiresAtMs == null) {
                        callExpiresAtMs = body.optString("expiresAt", "").takeIf { it.isNotEmpty() }?.toLongOrNull()
                    }
                } catch (_: Exception) {}
            }
            // Fallback for notification-only deliveries: use FCM server send time when ts/expiresAt are absent.
            if (callTs == null) {
                val sentAt = remoteMessage.sentTime
                if (sentAt > 0L) callTs = sentAt
            }
            if (callExpiresAtMs == null && callTs != null) {
                callExpiresAtMs = callTs + CALL_RING_TIMEOUT_MS
            }
            // Extra stale guard by FCM envelope time.
            // Some delayed deliveries may carry incomplete payload timestamps; sentTime still reflects old push.
            val sentAtMs = remoteMessage.sentTime.takeIf { it > 0L }
            if (sentAtMs != null && (System.currentTimeMillis() - sentAtMs) >= CALL_RING_TIMEOUT_MS) {
                    Log.i(TAG, "[INCOMING_CALL] FCM call push stale by sentTime callId=$callId sentAtMs=$sentAtMs")
                    EndedCallIds.add(this, callId)
                    try {
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
                    } catch (_: Exception) {}
                    showMissedCallNotification(callId, from, fromNick)
                    return
            }
            // Inclusive end of ring window (same as JS callExpiry / backend). No grace after expiresAt:
            // otherwise delayed FCM briefly opens IncomingCallActivity after a missed/ended call.
            if (callExpiresAtMs != null && System.currentTimeMillis() >= callExpiresAtMs) {
                    Log.i(TAG, "[INCOMING_CALL] FCM call push treated as stale (delayed delivery) callId=$callId expiresAtMs=$callExpiresAtMs ts=$callTs")
                    EndedCallIds.add(this, callId)
                    try {
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
                    } catch (_: Exception) {}
                    showMissedCallNotification(callId, from, fromNick)
                    return
            }
            // Don't flash incoming UI when call is about to auto-end anyway.
            if (callExpiresAtMs != null) {
                val remainingMs = callExpiresAtMs - System.currentTimeMillis()
                if (remainingMs <= MIN_REMAINING_WINDOW_TO_OPEN_UI_MS) {
                    Log.i(TAG, "[INCOMING_CALL] FCM call push stale by remaining window callId=$callId remainingMs=$remainingMs")
                    EndedCallIds.add(this, callId)
                    try {
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
                    } catch (_: Exception) {}
                    showMissedCallNotification(callId, from, fromNick)
                    return
                }
            }
            // Dual-signal режим (data + notification) может доставить одно и то же call событие дважды.
            // Отсекаем дубликаты по callId в коротком окне, чтобы не было двойного запуска экрана.
            if (!markIncomingCallAsFresh(callId)) {
                Log.i(TAG, "[INCOMING_CALL] SKIP dedup window (recent duplicate) callId=$callId")
                return
            }
            val keyguardLocked = try {
                (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked == true
            } catch (_: Exception) { false }
            val isInteractive = try {
                (getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive == true
            } catch (_: Exception) { true }
            vLog("[INCOMING_CALL] FCM call push: callId=$callId keyguardLocked=$keyguardLocked isInteractive=$isInteractive")
            // Пропуск только если пользователь прямо сейчас смотрит на экран входящего (дубликат пуша или тот же звонок). Иначе показываем — в т.ч. повторный звонок после отмены/сообщения.
            if (IncomingCallActivity.isInForeground) {
                Log.i(TAG, "[INCOMING_CALL] SKIP IncomingCallActivity already in foreground callId=$callId")
                return
            }
            Log.i(TAG, "[INCOMING_CALL] proceed callId=$callId keyguardLocked=$keyguardLocked isInteractive=$isInteractive")
            vLog("[INCOMING_CALL] proceeding: main thread → dismiss → startActivity → FGS")
            // Всегда показываем входящий из FCM: без условий по foreground/фоне/блокировке. Пуши — единственный надёжный канал; сокет может быть отключён, приложение убито, экран выключен.
            // Wake lock: даём процессу время запустить FGS и показать full-screen intent (особенно при убитом приложении).
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            val wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "livi:incoming_call")?.apply {
                try { acquire(10 * 60 * 1000L) } catch (_: Exception) {}
            }
            Handler(Looper.getMainLooper()).postDelayed({
                try { wakeLock?.release() } catch (_: Exception) {}
            }, 8000L)
            // onMessageReceived — worker thread: startActivity/startForegroundService и показ уведомлений только с main looper (иначе экран/FGS и мелодия нестабильны в фоне).
            Handler(Looper.getMainLooper()).post {
                val appForegroundNow = isAppProcessForeground()
                var activityLaunchOk = false
                try {
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
                    dismissMessageNotificationsForIncomingCall(nm)
                    vLog("[INCOMING_CALL] dismissMessageNotificationsForIncomingCall done")
                } catch (e: Exception) {
                    Log.w(TAG, "[INCOMING_CALL] dismissMessageNotificationsForIncomingCall failed", e)
                }
                ensureCallChannel(this@LiviFirebaseMessagingService)
                try {
                    LiviAppModule.beginBackgroundMediaSuppressionStatic(this@LiviFirebaseMessagingService)
                } catch (_: Exception) {}
                try {
                    val launchIntent = buildIncomingCallActivityIntent(
                        this@LiviFirebaseMessagingService,
                        callId,
                        from,
                        fromNick,
                        hasVideoCall,
                        returnMainOnDismiss = MainActivity.isInForeground,
                    ).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(launchIntent)
                    activityLaunchOk = true
                    Log.i(TAG, "[INCOMING_CALL] startActivity OK callId=$callId")
                    vLog("[INCOMING_CALL] startActivity(IncomingCallActivity) on main OK callId=$callId")
                } catch (e: Exception) {
                    Log.w(
                        TAG,
                        "[INCOMING_CALL] startActivity FAILED callId=$callId msg=${e.message} (FGS will retry)",
                        e
                    )
                }
                val needsForegroundService = !activityLaunchOk || keyguardLocked || !isInteractive
                if (needsForegroundService) {
                    startIncomingCallForegroundService(
                        callId,
                        from,
                        fromNick,
                        headsUpOnly = false,
                        silentNotification = true
                    )
                } else {
                    vLog("[INCOMING_CALL] skip FGS: foreground activity launch owns incoming UI callId=$callId")
                }
                try {
                    if (!appForegroundNow) {
                        val params = JSONObject()
                            .put("callId", callId)
                            .put("source", "incoming_call_fcm")
                            .put("appForeground", false)
                            .put("isInteractive", isScreenInteractive())
                            .toString()
                        LiviAppModule.trackAppEventStatic(this@LiviFirebaseMessagingService, "fgs_start_background", params)
                    }
                } catch (_: Exception) {}
                vLog("[INCOMING_CALL] incoming UI dispatch done callId=$callId needsFgs=$needsForegroundService")
            }
            return
        }
        if (typeNorm == "call_canceled" && callId != null) {
            LiviOngoingCallHelper.clearOngoingCallIfMatches(applicationContext, callId)
            val activeIncomingId = IncomingCallActivity.activeCallId
            val clearSharedIncomingUi = activeIncomingId.isBlank() || activeIncomingId == callId
            if (clearSharedIncomingUi) {
                try {
                    stopService(Intent(this, IncomingCallForegroundService::class.java))
                } catch (_: Exception) {}
                LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
            }
            deliverIncomingCallCanceled(applicationContext, callId)
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
                showMissedCallNotification(callId, fromCanceled.toString(), fromNickCanceled)
            } else {
                showMissedCallNotification(callId, "", fromNickCanceled)
            }
            Log.d(
                TAG,
                "FCM call_canceled: incoming canceled, missed shown, alive=${IncomingCallActivity.isAlive} activeCallId=${IncomingCallActivity.activeCallId} callId=$callId"
            )
            return
        }
        // Абонент принял вызов — закрыть нативный экран исходящего, вывести MainActivity, сохранить callId для JS (call:getAccepted → call:accepted → переход на VideoCall).
        if (typeNorm == "call_accepted" && callId != null) {
            vLog("FCM call_accepted: closing outgoing, MainActivity callId=$callId")
            // 1) Broadcast — если OutgoingCallActivity на экране, закроется по нему
            val closeOutgoing = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeOutgoing)
            LiviOutgoingCallService.stop(this, callId)
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
        // Звонок завершён: снять уведомление входящего, закрыть экран исходящего. «Пропущенный вызов» только если разговор не был принят (таймаут/отмена).
        if (typeNorm == "call_ended" && callId != null) {
            EndedCallIds.add(this, callId)
            val activeIncomingId = IncomingCallActivity.activeCallId
            if (activeIncomingId.isBlank() || activeIncomingId == callId) {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(NOTIFICATION_ID_INCOMING_CALL)
            }
            val cancelIntent = Intent(ACTION_CALL_CANCELED).apply {
                setPackage(packageName)
                putExtra(EXTRA_CALL_ID, callId)
            }
            sendBroadcast(cancelIntent)
            val endedFromActiveRaw = data["endedFromActive"] ?: bodyEndedFromActive ?: ""
            val endedFromActive = "true" == endedFromActiveRaw
            if (!endedFromActive) {
                var fromNickEnded = data["fromNick"] ?: ""
                if (fromNickEnded.isEmpty() && data["body"] != null) {
                    try {
                        fromNickEnded = org.json.JSONObject(data["body"]!!).optString("fromNick", "")
                    } catch (_: Exception) {}
                }
                var fromUserId = from ?: data["fromUserId"] ?: ""
                if (fromUserId.isEmpty() && data["body"] != null) {
                    try {
                        val body = org.json.JSONObject(data["body"]!!)
                        fromUserId = body.optString("fromUserId", "").takeIf { it.isNotEmpty() }
                            ?: body.optString("from", "").takeIf { it.isNotEmpty() }
                            ?: ""
                    } catch (_: Exception) {}
                }
                showMissedCallNotification(callId, fromUserId, fromNickEnded)
                Log.d(TAG, "FCM call_ended: missed/timeout, notification only (no startActivity) callId=$callId")
                return
            }

            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(closeIntent)
            if (!isAppProcessForeground()) {
                val activityIntent = Intent(this, OutgoingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                }
                try {
                    startActivity(activityIntent)
                } catch (e: Exception) {
                    Log.w(TAG, "FCM call_ended: startActivity failed", e)
                }
                Log.d(TAG, "FCM call_ended: endedFromActive, broadcast + fallback startActivity(close) callId=$callId")
            } else {
                Log.d(TAG, "FCM call_ended: endedFromActive, broadcast only (foreground) callId=$callId")
            }
            // Собеседник в системном PiP часто без call:ended по сокету. MainActivity закрывает PiP только если isInPictureInPictureMode.
            val closePipIntent = Intent(ACTION_CLOSE_PIP_CALL_ENDED).apply { setPackage(packageName) }
            sendBroadcast(closePipIntent)
            Log.d(TAG, "FCM call_ended: sent ACTION_CLOSE_PIP_CALL_ENDED (endedFromActive=true) callId=$callId")
            return
        }
        // Сообщение: одно уведомление на чат (от одного отправителя) — «От кого HH:MM» + превью; бейдж по общему unreadCount из пуша.
        if (typeNorm == "message") {
            vLog("FCM type=message")
            if (remoteMessage.notification != null) {
                vLog("FCM message: notification payload present, skip native (Expo)")
                return
            }
            // КРИТИЧНО: unreadCount читаем из корня data (FCM передаёт все ключи плоско) — иначе при отсутствии body остаётся 1 и бейдж неверный.
            var unreadCount = data["unreadCount"]?.toString()?.toIntOrNull()?.coerceAtLeast(0) ?: 0
            var fromUserIdMsg = (data["fromUserId"] ?: data["from"])?.toString()?.trim() ?: ""
            var fromNickMsg = ""
            var sentAtIso = ""
            var messagePreview = ""
            if (data["body"] != null) {
                try {
                    val body = JSONObject(data["body"]!!)
                    if (unreadCount <= 0) unreadCount = body.optInt("unreadCount", 1).coerceAtLeast(0)
                    if (fromUserIdMsg.isEmpty()) fromUserIdMsg = body.optString("fromUserId", "").trim().ifEmpty { body.optString("from", "").trim() }
                    if (fromNickMsg.isEmpty()) fromNickMsg = body.optString("fromNick", "").trim()
                    if (sentAtIso.isEmpty()) sentAtIso = body.optString("sentAt", "").trim()
                    if (messagePreview.isEmpty()) messagePreview = body.optString("messagePreview", "").trim()
                } catch (_: Exception) {}
            }
            if (unreadCount <= 0) unreadCount = 1
            if (fromNickMsg.isEmpty()) fromNickMsg = data["fromNick"]?.trim() ?: ""
            if (sentAtIso.isEmpty()) sentAtIso = data["sentAt"]?.trim() ?: ""
            if (messagePreview.isEmpty()) messagePreview = data["messagePreview"]?.trim() ?: ""
            if (fromUserIdMsg.isEmpty()) fromUserIdMsg = data["fromUserId"]?.toString()?.trim() ?: data["from"]?.toString()?.trim() ?: ""
            if (fromNickMsg.isEmpty()) fromNickMsg = "—"
            var messageId = data["messageId"]?.toString()?.trim() ?: ""
            if (messageId.isEmpty() && data["body"] != null) {
                try {
                    messageId = JSONObject(data["body"]!!).optString("messageId", "").trim()
                } catch (_: Exception) {}
            }
            val timeStr = formatMessageNotificationTime(sentAtIso)
            val duplicateMessage = messageId.isNotEmpty() && LiviAppModule.wasMessageNotifiedForId(this, messageId)
            if (duplicateMessage) {
                LiviAppModule.updateAppIconBadgeFromUnreadAndMissed(this, unreadCount)
                showMessageNotificationWithPreview(this, fromUserIdMsg, fromNickMsg, timeStr, messagePreview, unreadCount, allowAlert = false)
                vLog("FCM message: duplicate messageId=$messageId, silent shade update")
                return
            }
            if (messageId.isNotEmpty()) LiviAppModule.markMessageNotifiedForId(this, messageId)
            showMessageNotificationWithPreview(this, fromUserIdMsg, fromNickMsg, timeStr, messagePreview, unreadCount, allowAlert = true)
            LiviAppModule.updateAppIconBadgeFromUnreadAndMissed(this, unreadCount)
            vLog("FCM message: notified fromUserId=$fromUserIdMsg unreadCount=$unreadCount messageId=$messageId")
            return
        }
        vLog("FCM unhandled typeNorm=$typeNorm → Expo")
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

    /** «14:35», «вчера 14:35» или «12.03 14:35» для уведомления о сообщении */
    private fun formatMessageNotificationTime(sentAtIso: String): String {
        if (sentAtIso.isEmpty()) return ""
        return try {
            val utc = java.util.TimeZone.getTimeZone("UTC")
            val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = utc }
            var d = isoFormat.parse(sentAtIso)
            if (d == null) {
                val isoNoMs = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = utc }
                d = isoNoMs.parse(sentAtIso)
            }
            if (d == null) return ""
            val cal = Calendar.getInstance().apply { time = d }
            val now = Calendar.getInstance()
            val today = cal.get(Calendar.DAY_OF_YEAR) == now.get(Calendar.DAY_OF_YEAR) && cal.get(Calendar.YEAR) == now.get(Calendar.YEAR)
            val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
            val wasYesterday = cal.get(Calendar.DAY_OF_YEAR) == yesterday.get(Calendar.DAY_OF_YEAR) && cal.get(Calendar.YEAR) == yesterday.get(Calendar.YEAR)
            val timeStr = SimpleDateFormat("HH:mm", Locale.getDefault()).format(d)
            when {
                today -> timeStr
                wasYesterday -> "вчера $timeStr"
                else -> SimpleDateFormat("dd.MM HH:mm", Locale.getDefault()).format(d)
            }
        } catch (_: Exception) {
            ""
        }
    }

    /** Учёт пропущенного звонка и обновление общего summary-уведомления в шторке. */
    private fun showMissedCallNotification(callId: String, fromUserId: String, fromNick: String) {
        notifyMissedCallFromPush(this, callId, fromUserId, fromNick)
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
                Log.w(TAG, "startForegroundService failed, launching IncomingCallActivity directly", e)
                try {
                    startActivity(activityIntent)
                } catch (e2: Exception) {
                    Log.w(TAG, "startActivity fallback after FGS failure also failed", e2)
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
        private const val CHANNEL_ID_MISSED_CALL = "missed_call_v2"
        /** Обновления счётчика / sync из JS — без повторного heads-up. */
        private const val CHANNEL_ID_MISSED_CALL_SILENT = "missed_call_silent_v1"
        const val ACTION_CALL_CANCELED = "com.kolt12max.livi.CALL_CANCELED"
        /** Broadcast: закрыть системный PiP при пуше call_ended (MainActivity — только если isInPictureInPictureMode). */
        const val ACTION_CLOSE_PIP_CALL_ENDED = "com.kolt12max.livi.CLOSE_PIP_CALL_ENDED"
        const val EXTRA_CALL_ID = "callId"
        @JvmStatic
        private fun getSafeSmallIconRes(context: Context, fallback: Int): Int {
            return try {
                val appIcon = context.applicationInfo?.icon ?: 0
                if (appIcon != 0) appIcon else fallback
            } catch (_: Exception) {
                fallback
            }
        }

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
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    setSound(null, null)
                    setVibrationPattern(longArrayOf(0))
                    enableVibration(false)
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                    setShowBadge(true)
                }
                nm.createNotificationChannel(channel)
            }
        }

        /** Тихий канал пропущенных: обновление текста/счётчика без повторного heads-up. */
        @JvmStatic
        fun ensureMissedCallSilentChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID_MISSED_CALL_SILENT,
                    context.getString(R.string.missed_call_title),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    setSound(null, null)
                    setVibrationPattern(longArrayOf(0))
                    enableVibration(false)
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                    setShowBadge(true)
                }
                nm.createNotificationChannel(channel)
            }
        }

        /**
         * Пропущенный вызов: summary в шторке + счётчик. Дедуп по callId (FCM + локальный таймаут экрана входящего).
         */
        @JvmStatic
        fun notifyMissedCallFromPush(context: Context, callId: String, fromUserId: String, fromNick: String) {
            val appCtx = context.applicationContext
            Handler(Looper.getMainLooper()).post {
                try {
                    notifyMissedCallFromPushOnMain(appCtx, callId, fromUserId, fromNick)
                } catch (e: Exception) {
                    Log.w(TAG, "notifyMissedCallFromPush failed", e)
                }
            }
        }

        @JvmStatic
        private fun notifyMissedCallFromPushOnMain(
            context: Context,
            callId: String,
            fromUserId: String,
            fromNick: String
        ) {
            if (callId.isNotEmpty() && !LiviAppModule.tryClaimMissedCallNotification(context, callId)) {
                Log.i(TAG, "notifyMissedCallFromPushOnMain: skip duplicate callId=$callId")
                return
            }
            var uid = fromUserId.trim()
            var nick = fromNick
            if (uid.isEmpty() && callId.isNotEmpty()) {
                val meta = LiviAppModule.resolveIncomingCallMeta(context, callId)
                if (meta != null) {
                    uid = meta.first.trim()
                    if (nick.isBlank()) nick = meta.second
                }
            }
            if (uid.isEmpty()) {
                Log.w(TAG, "notifyMissedCallFromPushOnMain: missing caller userId callId=$callId")
                return
            }
            ensureMissedCallChannel(context)
            LiviAppModule.addPendingMissedCall(context, uid)
            LiviAppModule.saveMissedCallNick(context, uid, nick)
            val countForUser = LiviAppModule.incrementMissedCountForUser(context, uid)
            refreshMissedCallNotificationsInShade(context, allowAlert = true)
            LiviAppModule.updateAppIconBadgeFromMissedCount(context)
            Log.i(TAG, "notifyMissedCallFromPushOnMain: shown callId=$callId from=$uid countUser=$countForUser total=${LiviAppModule.getTotalMissedCount(context)}")
        }

        /**
         * Перерисовать уведомления о пропущенных в шторке по нативному счётчику:
         * 1 пропущенный — карточка «от кого», несколько — одно summary.
         * @param allowAlert true только при новом пропущенном (FCM/таймаут), не при sync из JS.
         */
        @JvmStatic
        fun refreshMissedCallNotificationsInShade(context: Context, allowAlert: Boolean = false) {
            val total = LiviAppModule.getTotalMissedCount(context)
            if (allowAlert) ensureMissedCallChannel(context) else ensureMissedCallSilentChannel(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (total <= 0) {
                try { nm.cancel(NOTIFICATION_ID_SUMMARY_MISSED_CALLS) } catch (_: Exception) {}
                return
            }
            if (total > 1) {
                updateSummaryMissedCallsNotification(context, total, allowAlert)
                return
            }
            try { nm.cancel(NOTIFICATION_ID_SUMMARY_MISSED_CALLS) } catch (_: Exception) {}
            try {
                val raw = LiviAppModule.getMissedCountByUserJson(context)
                val map = JSONObject(raw)
                val keys = map.keys().asSequence().toList()
                for (k in keys) {
                    val c = map.optInt(k, 0)
                    if (c > 0) updateMissedCallNotification(context, k, c, allowAlert)
                }
            } catch (e: Exception) {
                Log.w(TAG, "refreshMissedCallNotificationsInShade failed", e)
            }
        }

        /** Обновить системное уведомление «пропущенный видеозвонок»: «От кого HH:MM» + текст по счётчику. */
        @JvmStatic
        fun updateMissedCallNotification(context: Context, userId: String, count: Int, allowAlert: Boolean = false) {
            if (userId.isBlank() || count < 0) return
            if (allowAlert) ensureMissedCallChannel(context) else ensureMissedCallSilentChannel(context)
            val channelId = if (allowAlert) CHANNEL_ID_MISSED_CALL else CHANNEL_ID_MISSED_CALL_SILENT
            val fromNick = LiviAppModule.getMissedCallNick(context, userId)
            val timeStr = SimpleDateFormat("HH:mm", Locale.getDefault()).format(java.util.Date())
            val displayNick = fromNick.trim().ifEmpty { context.getString(R.string.incoming_call_title) }
            val title = "$displayNick $timeStr".trim().ifEmpty { context.getString(R.string.missed_call_video) }
            val body = when {
                count > 1 && displayNick.isNotEmpty() -> context.getString(R.string.missed_call_from_count, count, displayNick)
                count > 1 -> context.getString(R.string.missed_call_from_count, count, context.getString(R.string.incoming_call_title))
                else -> context.getString(R.string.missed_call_video)
            }
            val safeBody = body.ifEmpty { context.getString(R.string.missed_call_video) }
            val smallIconRes = getSafeSmallIconRes(context, android.R.drawable.ic_menu_call)
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
            val notificationId = LiviAppModule.getMissedNotificationIdForUser(userId)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!allowAlert) {
                try { nm.cancel(notificationId) } catch (_: Exception) {}
            }
            val notification = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(safeBody)
                .setContentIntent(contentPending)
                .setDeleteIntent(deletePending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setNumber(count.coerceAtLeast(1))
                .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                .setPriority(if (allowAlert) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()
            nm.notify(notificationId, notification)
        }

        /** ID уведомлений для сводок: общие пропущенные звонки и непрочитанные сообщения. */
        const val NOTIFICATION_ID_SUMMARY_MISSED_CALLS = 2001
        const val NOTIFICATION_ID_SUMMARY_UNREAD = 2002
        /** База для ID уведомлений о сообщениях от одного пользователя (один ID на чат — группировка в шторке). */
        const val NOTIFICATION_ID_MESSAGE_BASE = 3000
        /**
         * Канал для пушей о сообщениях (FCM data-only → нативный notify).
         * v3: новый channel id — важность фиксируется при первом создании; MessagingStyle + cancel→notify для heads-up.
         */
        private const val CHANNEL_ID_UNREAD = "unread_messages_v3"
        private const val CHANNEL_ID_UNREAD_SILENT = "unread_messages_silent_v1"
        private const val RECENT_INCOMING_DEDUP_WINDOW_MS = 10_000L
        private val recentIncomingByCallId = HashMap<String, Long>()

        @Synchronized
        @JvmStatic
        private fun markIncomingCallAsFresh(callId: String): Boolean {
            val now = System.currentTimeMillis()
            val it = recentIncomingByCallId.entries.iterator()
            while (it.hasNext()) {
                val e = it.next()
                if (now - e.value > RECENT_INCOMING_DEDUP_WINDOW_MS) it.remove()
            }
            val prev = recentIncomingByCallId[callId]
            if (prev != null && (now - prev) <= RECENT_INCOMING_DEDUP_WINDOW_MS) return false
            recentIncomingByCallId[callId] = now
            return true
        }

        /** Снять уведомления о сообщениях перед показом входящего звонка, чтобы они не перекрывали полноэкранный экран. */
        @JvmStatic
        private fun dismissMessageNotificationsForIncomingCall(nm: NotificationManager) {
            try {
                cancelNotificationIfPresent(nm, NOTIFICATION_ID_SUMMARY_UNREAD)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    @Suppress("DEPRECATION")
                    val active = nm.activeNotifications
                    val base = NOTIFICATION_ID_MESSAGE_BASE
                    for (n in active) {
                        val id = n.id
                        if (id in base until base + 0x8000) cancelNotificationIfPresent(nm, id)
                    }
                }
            } catch (_: Exception) {}
        }

        @JvmStatic
        private fun cancelNotificationIfPresent(nm: NotificationManager, id: Int) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    @Suppress("DEPRECATION")
                    val exists = nm.activeNotifications?.any { it.id == id } == true
                    if (!exists) return
                }
                nm.cancel(id)
            } catch (_: Exception) {}
        }

        @JvmStatic
        fun ensureUnreadChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID_UNREAD,
                    context.getString(R.string.summary_unread_title),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                    val attrs = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                    setSound(soundUri, attrs)
                    enableVibration(true)
                    setVibrationPattern(longArrayOf(0, 220))
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                }
                nm.createNotificationChannel(channel)
            }
        }

        @JvmStatic
        fun ensureUnreadSilentChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID_UNREAD_SILENT,
                    context.getString(R.string.summary_unread_title),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    setSound(null, null)
                    enableVibration(false)
                    setVibrationPattern(longArrayOf(0))
                    setLockscreenVisibility(Notification.VISIBILITY_PUBLIC)
                }
                nm.createNotificationChannel(channel)
            }
        }

        /** Показать/обновить одно уведомление «N пропущенных звонков» в шторке. */
        @JvmStatic
        fun updateSummaryMissedCallsNotification(context: Context, total: Int, allowAlert: Boolean = false) {
            if (total <= 0) return
            if (allowAlert) ensureMissedCallChannel(context) else ensureMissedCallSilentChannel(context)
            val channelId = if (allowAlert) CHANNEL_ID_MISSED_CALL else CHANNEL_ID_MISSED_CALL_SILENT
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // For a single missed call keep only one "missed call" card (no extra summary).
            if (total <= 1) {
                try { nm.cancel(NOTIFICATION_ID_SUMMARY_MISSED_CALLS) } catch (_: Exception) {}
                return
            }
            val title = context.getString(R.string.summary_missed_calls_title)
            val body = context.getString(R.string.summary_missed_calls_count, total)
            val contentIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_OPEN_TAB_FRIENDS, true)
            }
            val contentPending = PendingIntent.getActivity(context, 0, contentIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val smallIconRes = getSafeSmallIconRes(context, android.R.drawable.ic_menu_call)
            // Avoid duplicate missed cards in shade:
            // if an individual missed notification is already visible on the same channel
            // (e.g. system/Expo notification payload), skip posting summary right now.
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    @Suppress("DEPRECATION")
                    val active = nm.activeNotifications
                    val hasIndividualMissed = active?.any { sbn ->
                        val id = sbn.id
                        id != NOTIFICATION_ID_SUMMARY_MISSED_CALLS &&
                            sbn.notification?.channelId == CHANNEL_ID_MISSED_CALL
                    } == true
                    if (hasIndividualMissed) return
                }
            } catch (_: Exception) {}
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    @Suppress("DEPRECATION")
                    val active = nm.activeNotifications
                    val base = LiviAppModule.MISSED_NOTIFICATION_ID_BASE
                    for (n in active) {
                        val id = n.id
                        if (id in base until base + 0x8000) nm.cancel(id)
                    }
                }
            } catch (_: Exception) {}
            val notification = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(contentPending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(if (allowAlert) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()
            nm.notify(NOTIFICATION_ID_SUMMARY_MISSED_CALLS, notification)
        }

        /** Показать/обновить одно уведомление «N непрочитанных» в шторке. */
        @JvmStatic
        fun updateSummaryUnreadNotification(context: Context, total: Int, allowAlert: Boolean = false) {
            if (total <= 0) return
            val title = context.getString(R.string.summary_unread_title)
            val body = context.getString(R.string.summary_unread_count, total)
            buildAndShowUnreadNotification(context, NOTIFICATION_ID_SUMMARY_UNREAD, title, body, allowAlert)
        }

        /** Одно уведомление: сверху «N непрочитанных», снизу «От X в HH:MM». */
        @JvmStatic
        fun updateSummaryUnreadNotificationWithLast(context: Context, total: Int, lastFromNick: String, timeStr: String, allowAlert: Boolean = false) {
            if (total <= 0) return
            val title = context.getString(R.string.summary_unread_count, total)
            val fromLabel = lastFromNick.trim().ifEmpty { "—" }
            val body = context.getString(R.string.summary_unread_from_time, fromLabel, timeStr)
            buildAndShowUnreadNotification(context, NOTIFICATION_ID_SUMMARY_UNREAD, title, body, allowAlert)
        }

        /** Сообщение: одно summary-уведомление «N непрочитанных» с последним отправителем и временем. */
        @JvmStatic
        fun showMessageNotificationWithPreview(context: Context, fromUserId: String, fromNick: String, timeStr: String, messagePreview: String, unreadFromSender: Int = 1, allowAlert: Boolean = false) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    @Suppress("DEPRECATION")
                    val active = nm.activeNotifications
                    val base = NOTIFICATION_ID_MESSAGE_BASE
                    for (n in active) {
                        val id = n.id
                        if (id in base until base + 0x8000) nm.cancel(id)
                    }
                }
            } catch (_: Exception) {}
            val unreadTotal = unreadFromSender.coerceAtLeast(1)
            updateSummaryUnreadNotificationWithLast(context, unreadTotal, fromNick, timeStr, allowAlert)
        }

        private fun buildAndShowUnreadNotification(context: Context, notificationId: Int, title: String, body: String, allowAlert: Boolean = false) {
            if (allowAlert) ensureUnreadChannel(context) else ensureUnreadSilentChannel(context)
            val channelId = if (allowAlert) CHANNEL_ID_UNREAD else CHANNEL_ID_UNREAD_SILENT
            val safeTitle = title.trim().ifEmpty { context.getString(R.string.summary_unread_title) }
            val safeBody = body.trim().ifEmpty { context.getString(R.string.notification_new_message) }
            val contentIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_OPEN_TAB_FRIENDS, true)
            }
            val contentPending = PendingIntent.getActivity(context, 0, contentIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val smallIconRes = getSafeSmallIconRes(context, android.R.drawable.ic_dialog_info)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!allowAlert) {
                try { nm.cancel(notificationId) } catch (_: Exception) {}
            }
            val notification = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(smallIconRes)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setContentIntent(contentPending)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(if (allowAlert) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .build()
            nm.notify(notificationId, notification)
        }

        /**
         * Инициатор отменил: EndedCallIds, broadcast (+ повторы).
         * JUST_CLOSE через startActivity — только fallback, если broadcast не закрыл экран:
         * немедленный JUST_CLOSE при живом Incoming даёт REORDER_TO_FRONT и мерцание
         * «ещё одной страницы» поверх уже закрывающегося UI.
         */
        @JvmStatic
        fun deliverIncomingCallCanceled(context: Context, callId: String, from: String = "", fromNick: String = "") {
            if (callId.isBlank()) return
            EndedCallIds.add(context, callId)
            LiviOngoingCallHelper.clearOngoingCallIfMatches(context, callId)
            val cancelIntent = Intent(ACTION_CALL_CANCELED).apply {
                setPackage(context.packageName)
                putExtra(EXTRA_CALL_ID, callId)
            }
            try {
                context.sendBroadcast(cancelIntent)
            } catch (e: Exception) {
                Log.w(TAG, "deliverIncomingCallCanceled broadcast failed", e)
            }
            val handler = Handler(Looper.getMainLooper())
            for (delayMs in longArrayOf(250L, 650L)) {
                handler.postDelayed({
                    try {
                        context.sendBroadcast(cancelIntent)
                    } catch (_: Exception) {}
                }, delayMs)
            }
            // Fallback: receiver мог не успеть зарегистрироваться (ранний cancel).
            handler.postDelayed({
                if (!(IncomingCallActivity.isAlive && IncomingCallActivity.activeCallId == callId)) return@postDelayed
                try {
                    val closeIntent = buildIncomingCallActivityIntent(context, callId, from, fromNick).apply {
                        putExtra(IncomingCallActivity.EXTRA_JUST_CLOSE, true)
                    }
                    context.startActivity(closeIntent)
                    Log.d(TAG, "deliverIncomingCallCanceled: delayed JUST_CLOSE fallback callId=$callId")
                } catch (e: Exception) {
                    Log.w(TAG, "deliverIncomingCallCanceled JUST_CLOSE failed callId=$callId", e)
                }
            }, 400L)
        }

        /** Intent для IncomingCallActivity (поверх блокировки и домашнего экрана). */
        @JvmStatic
        fun buildIncomingCallActivityIntent(
            context: Context,
            callId: String,
            from: String,
            fromNick: String,
            hasVideo: Boolean = true,
            returnMainOnDismiss: Boolean = false,
        ): Intent {
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
                putExtra(IncomingCallActivity.EXTRA_HAS_VIDEO, hasVideo)
                putExtra(IncomingCallActivity.EXTRA_RETURN_MAIN_ON_DISMISS, returnMainOnDismiss)
            }
        }

        /** Уведомление входящего звонка: заголовок, текст, full-screen intent. Без кнопок — принять/отклонить только на нативном экране. */
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
            val smallIconRes = getSafeSmallIconRes(context, android.R.drawable.ic_menu_call)

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS_VISUAL)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(fullScreenPendingIntent)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setOngoing(true)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(27_000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()
        }

        private const val REQUEST_CONTENT = 2003

        /** Постоянное уведомление (heads-up): LiVi, имя звонящего, «Входящий видеозвонок». Без кнопок. */
        @JvmStatic
        fun buildIncomingCallNotificationHeadsUpOnly(context: Context, callId: String, from: String, fromNick: String): Notification {
            val appName = context.getString(R.string.app_name)
            val callerName = if (fromNick.isNotEmpty()) fromNick else context.getString(R.string.incoming_call_unknown)
            val title = appName
            val subtitle = "${callerName} — ${context.getString(R.string.incoming_call_title)}"
            val smallIconRes = getSafeSmallIconRes(context, android.R.drawable.ic_menu_call)

            val contentIntent = buildIncomingCallActivityIntent(context, callId, from, fromNick)
            val contentPending = PendingIntent.getActivity(
                context,
                NOTIFICATION_ID_INCOMING_CALL,
                contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS_VISUAL)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(contentPending)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(27_000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()
        }

        /** Тихое уведомление входящего: без heads-up, только иконка в статус-баре и запись в шторке. Без кнопок. */
        @JvmStatic
        fun buildIncomingCallNotificationSilent(context: Context, callId: String, from: String, fromNick: String): Notification {
            val title = if (fromNick.isNotEmpty()) fromNick else context.getString(R.string.incoming_call_title)
            val subtitle = context.getString(R.string.incoming_call_title)
            val smallIconRes = getSafeSmallIconRes(context, android.R.drawable.ic_menu_call)

            val contentIntent = buildIncomingCallActivityIntent(context, callId, from, fromNick)
            val contentPending = PendingIntent.getActivity(
                context,
                NOTIFICATION_ID_INCOMING_CALL,
                contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            return NotificationCompat.Builder(context, CHANNEL_ID_CALLS_SILENT)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(contentPending)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(27_000)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
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
