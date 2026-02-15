package com.kolt12max.livi

import android.app.Notification
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
 * full-screen не успевает сработать. Сервис останавливается по broadcast от IncomingCallActivity или по таймауту.
 */
class IncomingCallForegroundService : Service() {

    private var currentCallId: String? = null
    private var activityShownReceiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null

    private var answeredReceiver: BroadcastReceiver? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
            ?: return stopAndReturn()
        val from = intent.getStringExtra(EXTRA_FROM) ?: return stopAndReturn()
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        val headsUpOnly = intent.getBooleanExtra(EXTRA_HEADS_UP_ONLY, false)

        currentCallId = callId
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
            Log.d(TAG, "IncomingCallForegroundService: timeout, stopping")
            cleanupAndStop()
        }
        handler.postDelayed(timeoutRunnable!!, TIMEOUT_MS)

        return START_NOT_STICKY
    }

    private fun cleanupAndStop() {
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        activityShownReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        activityShownReceiver = null
        answeredReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        answeredReceiver = null
        currentCallId = null
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
        private const val TIMEOUT_MS = 45_000L
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        /** Broadcast: IncomingCallActivity открылась, сервис может снять уведомление и остановиться */
        const val ACTION_INCOMING_CALL_ACTIVITY_SHOWN = "com.kolt12max.livi.INCOMING_CALL_ACTIVITY_SHOWN"
        /** Режим «только heads-up»: не запускать IncomingCallActivity, уведомление с кнопками Принять/Отклонить */
        const val EXTRA_HEADS_UP_ONLY = "heads_up_only"
    }
}
