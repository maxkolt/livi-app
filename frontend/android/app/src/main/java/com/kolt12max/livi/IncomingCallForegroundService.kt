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

    private fun cancelPendingActivityLaunches() {
        for (r in pendingActivityLaunchRunnables) {
            handler.removeCallbacks(r)
        }
        pendingActivityLaunchRunnables.clear()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
            ?: return stopAndReturn()
        val from = intent.getStringExtra(EXTRA_FROM) ?: return stopAndReturn()
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        val headsUpOnly = intent.getBooleanExtra(EXTRA_HEADS_UP_ONLY, false)
        val silentNotification = intent.getBooleanExtra(EXTRA_SILENT_NOTIFICATION, false)
        val minimized = intent.getBooleanExtra(EXTRA_MINIMIZED, false)

        vl("[INCOMING_FGS] onStartCommand callId=$callId minimized=$minimized")

        currentCallId = callId
        currentFrom = from
        currentFromNick = fromNick
        activityShownReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        activityShownReceiver = null
        callEndedReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callEndedReceiver = null
        declinedReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        declinedReceiver = null
        answeredReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        answeredReceiver = null
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        cancelPendingActivityLaunches()
        didDetachAfterActivityShown = false
        LiviFirebaseMessagingService.ensureCallChannel(this)
        if (!minimized) {
            LiviAppModule.startIncomingCallRingtoneAndVibrationStatic(applicationContext)
        }
        // silent: только иконка/шторка (без heads-up) — тап по уведомлению открывает экран (основной режим FCM/FGS).
        // headsUpOnly: баннер без full-screen intent (разблокированный экран).
        // иначе (редко): уведомление с setFullScreenIntent — может дать heads-up поверх UI.
        val notification = when {
            silentNotification -> LiviFirebaseMessagingService.buildIncomingCallNotificationSilent(this, callId, from, fromNick)
            headsUpOnly -> LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this, callId, from, fromNick)
            else -> LiviFirebaseMessagingService.buildIncomingCallNotification(this, callId, from, fromNick)
        }
        // Android 14+ (API 34): тип PHONE_CALL — система не накладывает ограничение «no camera/microphone» при старте из фона (VoIP/входящий вызов).
        // На старых версиях — SPECIAL_USE (только показ уведомления, камера/микрофон не используем в сервисе).
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
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
                        if (shownCallId == currentCallId) detachForegroundAfterIncomingActivityVisible()
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
        } else {
            vl("[INCOMING_FGS] minimized=true: skip delayed startActivity")
        }

        // Таймер 20 с уже крутится в IncomingCallActivity; второй в FGS при «свернуть в шторку» сдвинул бы конец звонка.
        if (!minimized) {
            timeoutRunnable = Runnable {
                vl("[INCOMING_FGS] timeout 20s closing")
                val cid = currentCallId
                if (!cid.isNullOrEmpty()) {
                    // Закрываем IncomingCallActivity через broadcast (startActivity из сервиса блокируется BAL на Android 14+).
                    val cancelIntent = Intent(LiviFirebaseMessagingService.ACTION_CALL_CANCELED).apply {
                        setPackage(packageName)
                        putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, cid)
                    }
                    sendBroadcast(cancelIntent)
                }
                cleanupAndStopFully()
            }
            handler.postDelayed(timeoutRunnable!!, TIMEOUT_MS)
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
    }

    private fun cleanupAndStopFully() {
        vl("[INCOMING_FGS] cleanupAndStopFully")
        LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        cancelPendingActivityLaunches()
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

    private fun stopAndReturn(): Int {
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        vl("[INCOMING_FGS] onDestroy")
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        cancelPendingActivityLaunches()
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
        private const val TIMEOUT_MS = 20_000L
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
        /** Broadcast: пользователь нажал «Отклонить» — FGS останавливается, чтобы второй звонок получил новый FGS. */
        const val ACTION_INCOMING_CALL_DECLINED = "com.kolt12max.livi.INCOMING_CALL_DECLINED"
    }
}
