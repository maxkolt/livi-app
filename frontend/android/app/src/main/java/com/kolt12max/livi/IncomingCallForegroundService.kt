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
 * Foreground-сервис для показа экрана входящего звонка поверх любых приложений, домашнего экрана и блокировки.
 * Уведомление с full-screen intent не снимается сразу — иначе на заблокированном/домашнем экране
 * full-screen не успевает сработать. Сервис останавливается по broadcast (call_canceled/call_ended), от IncomingCallActivity или по таймауту 20 сек.
 */
class IncomingCallForegroundService : Service() {

    private var currentCallId: String? = null
    private var currentFrom: String? = null
    private var currentFromNick: String? = null
    private var activityShownReceiver: BroadcastReceiver? = null
    private var callEndedReceiver: BroadcastReceiver? = null
    private var declinedReceiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null

    private var answeredReceiver: BroadcastReceiver? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
            ?: return stopAndReturn()
        val from = intent.getStringExtra(EXTRA_FROM) ?: return stopAndReturn()
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        val headsUpOnly = intent.getBooleanExtra(EXTRA_HEADS_UP_ONLY, false)
        val silentNotification = intent.getBooleanExtra(EXTRA_SILENT_NOTIFICATION, false)

        Log.e(TAG, "[INCOMING_FGS] onStartCommand callId=$callId from=$from (2nd call = fresh FGS if previous was declined)")

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
        LiviFirebaseMessagingService.ensureCallChannel(this)
        LiviAppModule.startIncomingCallRingtoneAndVibrationStatic(applicationContext)
        // При видеозвонке сразу «только шторка»: иконка в статус-баре, в шторке — полное уведомление (тап → экран входящего). Нативный экран открываем через startActivity ниже.
        val notification = when {
            silentNotification -> LiviFirebaseMessagingService.buildIncomingCallNotificationSilent(this, callId, from, fromNick)
            headsUpOnly -> LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this, callId, from, fromNick)
            else -> LiviFirebaseMessagingService.buildIncomingCallNotificationSilent(this, callId, from, fromNick)
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
                    handler.postDelayed({ if (shownCallId == currentCallId) cleanupAndStop(keepNotificationInShade = true) }, DELAY_CLEANUP_AFTER_ACTIVITY_SHOWN_MS)
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
                if (endedCallId == currentCallId) cleanupAndStop()
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
                if (answeredCallId == currentCallId) cleanupAndStop()
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
                    Log.e(TAG, "[INCOMING_FGS] ACTION_INCOMING_CALL_DECLINED received callId=$declinedCallId → cleanupAndStop (so 2nd call gets fresh FGS)")
                    cleanupAndStop()
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
            silentNotification -> Log.e(TAG, "[INCOMING_FGS] Mode=silent (shade only)")
            headsUpOnly -> Log.e(TAG, "[INCOMING_FGS] Mode=headsUpOnly (no full-screen)")
            else -> {
                Log.e(TAG, "[INCOMING_FGS] Mode=fullScreenIntent SDK=${Build.VERSION.SDK_INT} callId=$callId posting 3 startActivity attempts")
                val launchIntent = LiviFirebaseMessagingService.buildIncomingCallActivityIntent(this, callId, from, fromNick)
                val delaysMs = longArrayOf(300L, 900L, 2200L)
                for (i in delaysMs.indices) {
                    handler.postDelayed({
                        val cur = currentCallId
                        if (cur != callId) {
                            Log.e(TAG, "[INCOMING_FGS] startActivity attempt ${i + 1}/${delaysMs.size} SKIP currentCallId=$cur != callId=$callId")
                            return@postDelayed
                        }
                        try {
                            startActivity(launchIntent)
                            Log.e(TAG, "[INCOMING_FGS] startActivity(IncomingCallActivity) attempt ${i + 1}/${delaysMs.size} OK callId=$callId")
                        } catch (e: Exception) {
                            Log.e(TAG, "[INCOMING_FGS] startActivity(IncomingCallActivity) attempt ${i + 1}/${delaysMs.size} FAILED callId=$callId", e)
                        }
                    }, delaysMs[i])
                }
            }
        }

        timeoutRunnable = Runnable {
            Log.e(TAG, "[INCOMING_FGS] timeout 20s currentCallId=$currentCallId closing and stopping")
            val cid = currentCallId
            if (!cid.isNullOrEmpty()) {
                // Закрываем IncomingCallActivity через broadcast (startActivity из сервиса блокируется BAL на Android 14+).
                val cancelIntent = Intent(LiviFirebaseMessagingService.ACTION_CALL_CANCELED).apply {
                    setPackage(packageName)
                    putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, cid)
                }
                sendBroadcast(cancelIntent)
            }
            cleanupAndStop()
        }
        handler.postDelayed(timeoutRunnable!!, TIMEOUT_MS)

        return START_NOT_STICKY
    }

    /**
     * @param keepNotificationInShade true когда нативный экран входящего уже показан:
     *   уведомление не снимается, а остаётся в шторке (STOP_FOREGROUND_DETACH), чтобы пользователь
     *   мог свернуть экран, открыть шторку и по тапу на уведомление снова открыть экран входящего.
     */
    private fun cleanupAndStop(keepNotificationInShade: Boolean = false) {
        Log.e(TAG, "[INCOMING_FGS] cleanupAndStop currentCallId=$currentCallId keepNotificationInShade=$keepNotificationInShade")
        LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
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
        if (!keepNotificationInShade) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } else {
            // Оставляем уведомление в шторке; по тапу откроется IncomingCallActivity (contentIntent).
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
        }
        stopSelf()
    }

    private fun stopAndReturn(): Int {
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        Log.e(TAG, "[INCOMING_FGS] onDestroy")
        LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic(applicationContext)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "IncomingCallFGS"
        /** 20 сек без ответа — совпадает с таймаутом на сервере; после этого приходит call_ended и «Пропущенный вызов». */
        private const val TIMEOUT_MS = 20_000L
        /** Задержка перед остановкой FGS с оставлением уведомления в шторке (DETACH). */
        private const val DELAY_CLEANUP_AFTER_ACTIVITY_SHOWN_MS = 3000L
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        /** Broadcast: IncomingCallActivity открылась, сервис может снять уведомление и остановиться */
        const val ACTION_INCOMING_CALL_ACTIVITY_SHOWN = "com.kolt12max.livi.INCOMING_CALL_ACTIVITY_SHOWN"
        /** Режим «только heads-up»: не запускать IncomingCallActivity, уведомление с кнопками Принять/Отклонить */
        const val EXTRA_HEADS_UP_ONLY = "heads_up_only"
        /** Тихий режим: без heads-up (только иконка/шторка). */
        const val EXTRA_SILENT_NOTIFICATION = "silent_notification"
        /** Broadcast: пользователь нажал «Отклонить» — FGS останавливается, чтобы второй звонок получил новый FGS. */
        const val ACTION_INCOMING_CALL_DECLINED = "com.kolt12max.livi.INCOMING_CALL_DECLINED"
    }
}
