package com.kolt12max.livi

import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.ServiceCompat

/**
 * Foreground-сервис для рингтона/вибрации и уведомления входящего (режим heads-up или тихий — задаётся из FCM).
 * После показа IncomingCallActivity уведомление может остаться в шторке — тап возвращает на экран входящего.
 */
class IncomingCallForegroundService : Service() {

    private fun vl(msg: String) {
        if (BuildConfig.ENABLE_FCM_VERBOSE_LOG) Log.d(TAG, msg)
    }

    private var currentCallId: String? = null
    private var currentFrom: String? = null
    private var currentFromNick: String? = null
    private var activityShownReceiver: BroadcastReceiver? = null
    private var callEndedReceiver: BroadcastReceiver? = null
    private var declinedReceiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    /** Отложенные startActivity(300/900/2200 ms) — обязательно снимать, иначе после «Назад»/stopForeground экран снова всплывает. */
    private val pendingActivityLaunchRunnables = mutableListOf<Runnable>()

    private var answeredReceiver: BroadcastReceiver? = null
    /** После detach foreground (экран ведёт рингтон) — в onDestroy не дергать полный stop (vibrator.cancel ломает вибро Activity). */
    private var stopFullIncomingAudioOnDestroy = true
    /** Уже отцепили foreground после показа IncomingCallActivity (избегаем двойного DETACH). */
    private var didDetachAfterActivityShown = false
    /** startForeground() до тяжёлой работы (ringtone/receivers) — иначе ANR/FGS timeout при двойном onStartCommand. */
    private var didPromoteForeground = false

    private fun cancelPendingActivityLaunches() {
        for (r in pendingActivityLaunchRunnables) {
            handler.removeCallbacks(r)
        }
        pendingActivityLaunchRunnables.clear()
    }

    /**
     * Не пытаемся повторно открыть IncomingCallActivity, если она уже живёт для того же callId.
     * Иначе delayed-attempt'ы сервиса вызывают lifecycle flapping (onPause/onResume) на одном экране.
     */
    private fun shouldSkipActivityLaunch(callId: String): Boolean {
        return IncomingCallActivity.isAlive && IncomingCallActivity.activeCallId == callId
    }

    private fun unregisterAllReceivers() {
        activityShownReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        activityShownReceiver = null
        callEndedReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        callEndedReceiver = null
        declinedReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        declinedReceiver = null
        answeredReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        answeredReceiver = null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID).orEmpty()
        val from = intent?.getStringExtra(EXTRA_FROM).orEmpty()
        val fromNick = intent?.getStringExtra(EXTRA_FROM_NICK).orEmpty()
        val headsUpOnly = intent?.getBooleanExtra(EXTRA_HEADS_UP_ONLY, false) == true
        val minimized = intent?.getBooleanExtra(EXTRA_MINIMIZED, false) == true
        val silentNotification = intent?.getBooleanExtra(EXTRA_SILENT_NOTIFICATION, false) == true || minimized
        val remainingTimeoutMs = intent?.getLongExtra(EXTRA_REMAINING_TIMEOUT_MS, TIMEOUT_MS)?.coerceAtLeast(0L) ?: TIMEOUT_MS

        vl("[INCOMING_FGS] onStartCommand callId=$callId minimized=$minimized")

        // Любой startForegroundService() обязан быстро вызвать startForeground() (в т.ч. после DETACH).
        // ВАЖНО: здесь публикуется ПЕРВОЕ уведомление сервиса, и именно по нему система решает,
        // запускать ли full-screen intent. Повторный startForeground ниже — уже обновление того же
        // id, а на обновление FSI не срабатывает. Поэтому режим берём фактический: раньше тут было
        // жёстко silent, из-за чего экран входящего никогда не поднимался через FSI и держался
        // только на разрешении «поверх других приложений».
        LiviFirebaseMessagingService.ensureCallChannel(this)
        promoteForegroundIfNeeded(
            callId.ifEmpty { "abort" },
            from,
            fromNick,
            silentNotification = silentNotification || callId.isEmpty() || from.isEmpty(),
            headsUpOnly = headsUpOnly,
        )

        if (callId.isEmpty() || from.isEmpty()) {
            vl("[INCOMING_FGS] onStartCommand abort invalid intent")
            return finishAbortStart()
        }
        if (EndedCallIds.isEnded(applicationContext, callId)) {
            vl("[INCOMING_FGS] onStartCommand SKIP call already ended callId=$callId")
            return finishAbortStart()
        }
        if (LiviOngoingCallHelper.shouldSuppressStaleIncoming(applicationContext, callId)) {
            vl("[INCOMING_FGS] onStartCommand SKIP stale incoming callId=$callId")
            LiviOngoingCallHelper.clearOngoingCallIfMatches(applicationContext, callId)
            return finishAbortStart()
        }

        currentCallId = callId
        currentFrom = from
        currentFromNick = fromNick
        LiviAppModule.saveIncomingCallMeta(applicationContext, callId, from, fromNick)
        unregisterAllReceivers()
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        cancelPendingActivityLaunches()
        didDetachAfterActivityShown = false
        promoteForegroundIfNeeded(callId, from, fromNick, silentNotification, headsUpOnly)
        if (!minimized) {
            LiviAppModule.startIncomingCallRingtoneAndVibrationStatic(applicationContext)
        }
        // silent: только иконка/шторка (без heads-up) — тап по уведомлению открывает экран (основной режим FCM/FGS).
        // headsUpOnly: баннер без full-screen intent (разблокированный экран).
        // иначе (редко): уведомление с setFullScreenIntent — может дать heads-up поверх UI.
        val notification = when {
            silentNotification -> LiviFirebaseMessagingService.buildIncomingCallNotificationSilent(this, callId, from, fromNick)
            headsUpOnly -> LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this, callId, from, fromNick)
            else -> buildIncomingCallNotificationResolved(callId, from, fromNick)
        }
        // Для Android 10+ используем PHONE_CALL как основной тип call-FGS.
        // Это согласовано с manifest (phoneCall|specialUse) и уменьшает warning'и FGS type tracking.
        // SPECIAL_USE оставляем только как legacy fallback для API < 29.
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        }
        // ВАЖНО: регистрируем receivers ДО startForeground().
        activityShownReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, i: Intent?) {
                val shownCallId = i?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (shownCallId == currentCallId) {
                    handler.post {
                        if (shownCallId != currentCallId) return@post
                        // IncomingCallActivity ведёт ring window и missed — FGS-таймаут не нужен (иначе двойной missed).
                        timeoutRunnable?.let { handler.removeCallbacks(it) }
                        timeoutRunnable = null
                        detachForegroundAfterIncomingActivityVisible()
                    }
                }
            }
        }
        val filter = IntentFilter(ACTION_INCOMING_CALL_ACTIVITY_SHOWN)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(activityShownReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(activityShownReceiver, filter)
        }

        callEndedReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, i: Intent?) {
                val endedCallId = i?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (endedCallId == currentCallId) cleanupAndStopFully()
            }
        }
        val filterEnded = IntentFilter(LiviFirebaseMessagingService.ACTION_CALL_CANCELED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callEndedReceiver, filterEnded, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(callEndedReceiver, filterEnded)
        }

        answeredReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, i: Intent?) {
                val answeredCallId = i?.getStringExtra(IncomingCallActivity.EXTRA_CALL_ID) ?: return
                if (answeredCallId == currentCallId) cleanupAndStopFully()
            }
        }
        val filterAnswered = IntentFilter(IncomingCallActivity.ACTION_CALL_ANSWERED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(answeredReceiver, filterAnswered, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(answeredReceiver, filterAnswered)
        }

        declinedReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, i: Intent?) {
                val declinedCallId = i?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (declinedCallId == currentCallId) {
                    vl("[INCOMING_FGS] ACTION_INCOMING_CALL_DECLINED callId=$declinedCallId → cleanupAndStop")
                    cleanupAndStopFully()
                }
            }
        }
        val filterDeclined = IntentFilter(ACTION_INCOMING_CALL_DECLINED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(declinedReceiver, filterDeclined, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(declinedReceiver, filterDeclined)
        }

        ServiceCompat.startForeground(
            this,
            LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL,
            notification,
            fgsType
        )
        didPromoteForeground = true

        when {
            silentNotification -> vl("[INCOMING_FGS] Mode=silent")
            headsUpOnly -> vl("[INCOMING_FGS] Mode=headsUpOnly")
            else -> vl("[INCOMING_FGS] Mode=fullScreenIntent SDK=${Build.VERSION.SDK_INT} callId=$callId")
        }
        // Сворачивание по «Назад»: только уведомление в шторке — не дёргать startActivity (иначе экран сразу вылезет снова).
        if (!minimized) {
            // Повторные startActivity из FGS (в т.ч. при heads-up), если мгновенный запуск из FCM не прошёл (BAL/блокировка).
            vl("[INCOMING_FGS] posting delayed startActivity (300/900/2200 ms) callId=$callId")
            val launchIntent = LiviFirebaseMessagingService.buildIncomingCallActivityIntent(this, callId, from, fromNick)
            val delaysMs = longArrayOf(300L, 900L, 2200L)
            for (i in delaysMs.indices) {
                val attemptIndex = i + 1
                val runnable = Runnable {
                    val cur = currentCallId
                    if (cur != callId) {
                        vl("[INCOMING_FGS] startActivity attempt $attemptIndex SKIP cur=$cur")
                        return@Runnable
                    }
                    if (shouldSkipActivityLaunch(callId)) {
                        vl("[INCOMING_FGS] startActivity attempt $attemptIndex SKIP IncomingCallActivity already alive callId=$callId")
                        return@Runnable
                    }
                    if (EndedCallIds.isEnded(applicationContext, callId)) {
                        vl("[INCOMING_FGS] startActivity attempt $attemptIndex SKIP ended callId=$callId")
                        return@Runnable
                    }
                    if (LiviOngoingCallHelper.shouldSuppressStaleIncoming(applicationContext, callId)) {
                        vl("[INCOMING_FGS] startActivity attempt $attemptIndex SKIP stale callId=$callId")
                        LiviOngoingCallHelper.clearOngoingCallIfMatches(applicationContext, callId)
                        return@Runnable
                    }
                    try {
                        startActivity(launchIntent)
                        vl("[INCOMING_FGS] startActivity attempt $attemptIndex OK")
                    } catch (e: Exception) {
                        Log.w(TAG, "[INCOMING_FGS] startActivity attempt $attemptIndex FAILED callId=$callId", e)
                    }
                }
                pendingActivityLaunchRunnables.add(runnable)
                handler.postDelayed(runnable, delaysMs[i])
            }

            // Все попытки прошли, а экрана нет — значит система молча заблокировала фоновый старт
            // (нет разрешения «поверх других приложений»). Тихая строчка в шторке такой звонок не
            // спасает: перевыпускаем уведомление как full-screen/heads-up — его система показывает
            // сама, без exemption на старт активити. На рабочем пути не срабатывает: если экран
            // поднялся, shouldSkipActivityLaunch отсекает.
            if (silentNotification) {
                val escalateRunnable = Runnable {
                    if (currentCallId != callId) return@Runnable
                    if (shouldSkipActivityLaunch(callId)) {
                        vl("[INCOMING_FGS] notification escalation SKIP: activity visible callId=$callId")
                        return@Runnable
                    }
                    if (EndedCallIds.isEnded(applicationContext, callId)) return@Runnable
                    if (LiviOngoingCallHelper.shouldSuppressStaleIncoming(applicationContext, callId)) return@Runnable
                    try {
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(
                            LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL,
                            buildIncomingCallNotificationResolved(callId, from, fromNick)
                        )
                        Log.w(
                            TAG,
                            "[INCOMING_FGS] activity still not visible → notification escalated to full-screen callId=$callId"
                        )
                        // Экран показать не удалось — повод напомнить пользователю про разрешение,
                        // но по факту, а не заранее. JS заберёт эту отметку при следующем открытии.
                        LiviAppModule.markIncomingCallDisplayFailure(applicationContext, fromNick)
                    } catch (e: Exception) {
                        Log.w(TAG, "[INCOMING_FGS] notification escalation failed callId=$callId", e)
                    }
                }
                pendingActivityLaunchRunnables.add(escalateRunnable)
                handler.postDelayed(escalateRunnable, NOTIFICATION_ESCALATE_DELAY_MS)
            }
        } else {
            vl("[INCOMING_FGS] minimized=true: skip delayed startActivity")
        }

        // Keep timeout while minimized in shade: otherwise incoming can ring indefinitely after leaving screen.
        if (!minimized || remainingTimeoutMs > 0L) {
            val timeoutMsToUse = if (minimized) remainingTimeoutMs else TIMEOUT_MS
            timeoutRunnable = Runnable {
                vl("[INCOMING_FGS] timeout closing — stop incoming")
                val cid = currentCallId
                val fromUid = currentFrom
                val nick = currentFromNick ?: ""
                val activityHandlesMissed = !cid.isNullOrEmpty() &&
                    IncomingCallActivity.isAlive &&
                    IncomingCallActivity.activeCallId == cid
                if (!activityHandlesMissed && !cid.isNullOrEmpty() && !fromUid.isNullOrEmpty()) {
                    try {
                        LiviFirebaseMessagingService.notifyMissedCallFromPush(
                            applicationContext,
                            cid,
                            fromUid,
                            nick
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "[INCOMING_FGS] notifyMissedCallFromPush failed", e)
                    }
                }
                if (!cid.isNullOrEmpty()) {
                    LiviFirebaseMessagingService.deliverIncomingCallCanceled(applicationContext, cid, fromUid ?: "", nick)
                }
                cleanupAndStopFully()
            }
            handler.postDelayed(timeoutRunnable!!, timeoutMsToUse)
        }

        return START_NOT_STICKY
    }

    /**
     * IncomingCallActivity показала UI и сама ведёт рингтон + вибрацию до ответа/отмены/20с.
     * MediaPlayer FGS не останавливаем здесь: иначе на keyguard звук обрывается до успешного старта
     * плеера в Activity — IncomingCallActivity вызывает [LiviAppModule.stopRingtonePlayerForCallKeepOnly] после play().
     */
    private fun detachForegroundAfterIncomingActivityVisible() {
        if (didDetachAfterActivityShown) return
        didDetachAfterActivityShown = true
        cancelPendingActivityLaunches()
        vl("[INCOMING_FGS] detach after activity visible: keep FGS ringtone until Activity play OK, DETACH, keep service")
        stopFullIncomingAudioOnDestroy = false
        activityShownReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        activityShownReceiver = null
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
        } catch (e: Exception) {
            Log.w(TAG, "[INCOMING_FGS] stopForeground DETACH failed", e)
        }
        // После DETACH следующий startForegroundService() снова обязан вызвать startForeground().
        didPromoteForeground = false
    }

    /**
     * Полноэкранный входящий экран надёжно поднимается поверх lock screen только при живом разрешении
     * USE_FULL_SCREEN_INTENT (Android 14+). Если его нет — деградируем до heads-up (баннер поверх экрана +
     * звонок из кода), а НЕ до тихого уведомления: иначе на 14+ без разрешения экран входящего молча не всплывёт.
     */
    private fun canShowFullScreenIncoming(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        return try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.canUseFullScreenIntent() != false
        } catch (_: Exception) { true }
    }

    private fun buildIncomingCallNotificationResolved(callId: String, from: String, fromNick: String) =
        if (canShowFullScreenIncoming()) {
            LiviFirebaseMessagingService.buildIncomingCallNotification(this, callId, from, fromNick)
        } else {
            LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this, callId, from, fromNick)
        }

    private fun promoteForegroundIfNeeded(
        callId: String,
        from: String,
        fromNick: String,
        silentNotification: Boolean,
        headsUpOnly: Boolean,
    ) {
        if (didPromoteForeground) return
        val notification = when {
            silentNotification -> LiviFirebaseMessagingService.buildIncomingCallNotificationSilent(this, callId, from, fromNick)
            headsUpOnly -> LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this, callId, from, fromNick)
            else -> buildIncomingCallNotificationResolved(callId, from, fromNick)
        }
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        }
        try {
            ServiceCompat.startForeground(
                this,
                LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL,
                notification,
                fgsType,
            )
            didPromoteForeground = true
            vl("[INCOMING_FGS] promoteForegroundIfNeeded OK callId=$callId")
        } catch (e: Exception) {
            Log.e(TAG, "[INCOMING_FGS] promoteForegroundIfNeeded failed callId=$callId", e)
        }
    }

    private fun cleanupAndStopFully() {
        vl("[INCOMING_FGS] cleanupAndStopFully")
        didPromoteForeground = false
        LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        cancelPendingActivityLaunches()
        unregisterAllReceivers()
        currentCallId = null
        currentFrom = null
        currentFromNick = null
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            Log.w(TAG, "[INCOMING_FGS] stopForeground REMOVE failed", e)
        }
        stopFullIncomingAudioOnDestroy = false
        stopSelf()
    }

    /** После startForegroundService(): уже вызвали startForeground — снимаем FGS и останавливаем сервис. */
    private fun finishAbortStart(): Int {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            Log.w(TAG, "[INCOMING_FGS] finishAbortStart stopForeground failed", e)
        }
        didPromoteForeground = false
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        vl("[INCOMING_FGS] onDestroy")
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        cancelPendingActivityLaunches()
        unregisterAllReceivers()
        if (stopFullIncomingAudioOnDestroy) {
            if (!IncomingCallActivity.isAlive) {
                LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
            } else {
                LiviAppModule.stopRingtonePlayerForCallKeepOnly()
            }
        } else {
            LiviAppModule.stopRingtonePlayerForCallKeepOnly()
        }
        stopFullIncomingAudioOnDestroy = true
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "IncomingCallFGS"
        /** 20 сек без ответа — совпадает с таймаутом на сервере и с IncomingCallActivity.INCOMING_TIMEOUT_MS. */
        private const val TIMEOUT_MS = 27_000L
        /**
         * Сразу после последней отложенной попытки startActivity (2200 мс): если экрана всё ещё нет,
         * тихое уведомление повышаем до full-screen — иначе при заблокированном фоновом старте
         * звонок остаётся только рингтоном без способа ответить.
         */
        private const val NOTIFICATION_ESCALATE_DELAY_MS = 2_600L
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        /** Broadcast: IncomingCallActivity открылась, сервис может снять уведомление и остановиться */
        const val ACTION_INCOMING_CALL_ACTIVITY_SHOWN = "com.kolt12max.livi.INCOMING_CALL_ACTIVITY_SHOWN"
        /** Режим «только heads-up»: не запускать IncomingCallActivity, уведомление с кнопками Принять/Отклонить */
        const val EXTRA_HEADS_UP_ONLY = "heads_up_only"
        /** Тихий режим: без heads-up (только иконка/шторка). */
        const val EXTRA_SILENT_NOTIFICATION = "silent_notification"
        /** Экран входящего свернули по кнопке «Назад» — только уведомление в шторке, без рингтона/вибрации. */
        const val EXTRA_MINIMIZED = "minimized"
        /** Remaining timeout (ms) until incoming auto-end when minimized to shade. */
        const val EXTRA_REMAINING_TIMEOUT_MS = "remaining_timeout_ms"
        /** Broadcast: пользователь нажал «Отклонить» — FGS останавливается, чтобы второй звонок получил новый FGS. */
        const val ACTION_INCOMING_CALL_DECLINED = "com.kolt12max.livi.INCOMING_CALL_DECLINED"
    }
}
