package com.kolt12max.livi

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
    private var headsUpOnlyMode: Boolean = false
    private var activityShownReceiver: BroadcastReceiver? = null
    private var callEndedReceiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    private var headsUpRefreshRunnable: Runnable? = null

    private var answeredReceiver: BroadcastReceiver? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
            ?: return stopAndReturn()
        val from = intent.getStringExtra(EXTRA_FROM) ?: return stopAndReturn()
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        val headsUpOnly = intent.getBooleanExtra(EXTRA_HEADS_UP_ONLY, false)

        currentCallId = callId
        currentFrom = from
        currentFromNick = fromNick
        headsUpOnlyMode = headsUpOnly
        LiviFirebaseMessagingService.ensureCallChannel(this)
        val notification = if (headsUpOnly) {
            LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this, callId, from, fromNick)
        } else {
            LiviFirebaseMessagingService.buildIncomingCallNotification(this, callId, from, fromNick)
        }
        ServiceCompat.startForeground(
            this,
            LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        )

        if (!headsUpOnly) {
            val activityIntent = LiviFirebaseMessagingService.buildIncomingCallActivityIntent(this, callId, from, fromNick).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(activityIntent)
            Log.d(TAG, "IncomingCallForegroundService: full-screen; activity started")
        } else {
            Log.d(TAG, "IncomingCallForegroundService: heads-up only (Accept/Decline on notification)")
            scheduleHeadsUpRefresh()
        }

        activityShownReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, i: Intent?) {
                val shownCallId = i?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (shownCallId == currentCallId) cleanupAndStop()
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

        timeoutRunnable = Runnable {
            Log.d(TAG, "IncomingCallForegroundService: timeout 20s, stopping")
            cleanupAndStop()
        }
        handler.postDelayed(timeoutRunnable!!, TIMEOUT_MS)

        return START_NOT_STICKY
    }

    /** Периодическое обновление уведомления, чтобы heads-up не гас через ~7 сек и оставался до 20 сек. */
    private fun scheduleHeadsUpRefresh() {
        headsUpRefreshRunnable?.let { handler.removeCallbacks(it) }
        var count = 0
        headsUpRefreshRunnable = object : Runnable {
            override fun run() {
                if (currentCallId == null || !headsUpOnlyMode) return
                if (count >= HEADS_UP_REFRESH_COUNT) return
                count++
                val cid = currentCallId ?: return
                val from = currentFrom ?: return
                val nick = currentFromNick ?: ""
                val notification = LiviFirebaseMessagingService.buildIncomingCallNotificationHeadsUpOnly(this@IncomingCallForegroundService, cid, from, nick)
                ServiceCompat.startForeground(
                    this@IncomingCallForegroundService,
                    LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
                Log.d(TAG, "IncomingCallForegroundService: heads-up refresh $count")
                handler.postDelayed(this, HEADS_UP_REFRESH_INTERVAL_MS)
            }
        }
        handler.postDelayed(headsUpRefreshRunnable!!, HEADS_UP_REFRESH_INTERVAL_MS)
    }

    private fun cleanupAndStop() {
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        headsUpRefreshRunnable?.let { handler.removeCallbacks(it) }
        headsUpRefreshRunnable = null
        activityShownReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        activityShownReceiver = null
        callEndedReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        callEndedReceiver = null
        answeredReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        answeredReceiver = null
        currentCallId = null
        currentFrom = null
        currentFromNick = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun stopAndReturn(): Int {
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "IncomingCallFGS"
        /** 20 сек без ответа — совпадает с таймаутом на сервере; после этого приходит call_ended и «Пропущенный вызов». */
        private const val TIMEOUT_MS = 20_000L
        private const val HEADS_UP_REFRESH_INTERVAL_MS = 6_000L
        private const val HEADS_UP_REFRESH_COUNT = 3
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        /** Broadcast: IncomingCallActivity открылась, сервис может снять уведомление и остановиться */
        const val ACTION_INCOMING_CALL_ACTIVITY_SHOWN = "com.kolt12max.livi.INCOMING_CALL_ACTIVITY_SHOWN"
        /** Режим «только heads-up»: не запускать IncomingCallActivity, уведомление с кнопками Принять/Отклонить */
        const val EXTRA_HEADS_UP_ONLY = "heads_up_only"
    }
}
