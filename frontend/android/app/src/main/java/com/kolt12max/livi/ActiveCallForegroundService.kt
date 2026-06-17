package com.kolt12max.livi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground-сервис во время активного видеозвонка (в т.ч. в PiP).
 * Держит процесс в статусе «foreground», чтобы Android не глушил сокет и сеть в фоне.
 * По тапу на уведомление открывается MainActivity.
 */
class ActiveCallForegroundService : Service() {

    private val audioMaintainHandler = Handler(Looper.getMainLooper())
    private var audioMaintainRunnable: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        partnerNick = intent?.getStringExtra(EXTRA_PARTNER_NICK)?.trim()?.takeIf { it.isNotEmpty() }
        audioOnly = intent?.getBooleanExtra(EXTRA_AUDIO_ONLY, false) == true
        // phoneCall + microphone: микрофон и приём голоса в фоне (навигатор / другое приложение поверх).
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
            if (Build.VERSION.SDK_INT >= 34) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            type
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), fgsType)
        LiviAppModule.setActiveCallForegroundRunningStatic(true)
        LiviAppModule.beginActiveCallVoiceAudioHoldStatic(applicationContext)
        scheduleAudioMaintainLoop()
        try {
            val p = org.json.JSONObject()
                .put("source", "active_call_service")
                .put("appForeground", MainActivity.isInForeground)
                .toString()
            if (!MainActivity.isInForeground) {
                LiviAppModule.trackAppEventStatic(applicationContext, "fgs_start_background", p)
            }
        } catch (_: Exception) {}
        return START_STICKY
    }

    override fun onDestroy() {
        cancelAudioMaintainLoop()
        LiviAppModule.setActiveCallForegroundRunningStatic(false)
        LiviAppModule.endActiveCallVoiceAudioHoldStatic(applicationContext)
        super.onDestroy()
    }

    private fun scheduleAudioMaintainLoop() {
        cancelAudioMaintainLoop()
        val r = object : Runnable {
            override fun run() {
                try {
                    LiviAppModule.maintainActiveCallVoiceAudioStatic(applicationContext)
                } catch (_: Exception) {}
                audioMaintainHandler.postDelayed(this, AUDIO_MAINTAIN_INTERVAL_MS)
            }
        }
        audioMaintainRunnable = r
        audioMaintainHandler.postDelayed(r, AUDIO_MAINTAIN_INTERVAL_MS)
    }

    private fun cancelAudioMaintainLoop() {
        audioMaintainRunnable?.let { audioMaintainHandler.removeCallbacks(it) }
        audioMaintainRunnable = null
    }

    private var partnerNick: String? = null
    private var audioOnly: Boolean = false

    private fun buildNotification(): Notification {
        val channelId = if (audioOnly) CHANNEL_ID_AUDIO else CHANNEL_ID
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channelName = if (audioOnly) {
                getString(R.string.active_audio_call_notification_channel)
            } else {
                getString(R.string.active_call_notification_channel)
            }
            val channel = NotificationChannel(
                channelId,
                channelName,
                NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }

        val title = if (audioOnly) {
            if (!partnerNick.isNullOrEmpty()) {
                getString(R.string.active_audio_call_notification_title_from, partnerNick)
            } else {
                getString(R.string.active_audio_call_notification_title_someone)
            }
        } else if (!partnerNick.isNullOrEmpty()) {
            getString(R.string.active_call_notification_title_from, partnerNick)
        } else {
            getString(R.string.active_call_notification_title_someone)
        }

        val contentText = if (audioOnly) {
            getString(R.string.active_audio_call_notification_text)
        } else {
            getString(R.string.active_call_notification_text)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_RETURN_TO_ACTIVE_CALL, true)
                putExtra(MainActivity.EXTRA_RETURN_TO_ACTIVE_CALL_AUDIO_ONLY, audioOnly)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle(title)
            .setContentText(contentText)
            .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_menu_call)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    companion object {
        private const val TAG = "ActiveCallFg"
        private const val AUDIO_MAINTAIN_INTERVAL_MS = 12_000L
        private const val CHANNEL_ID = "livi_active_call_channel"
        private const val CHANNEL_ID_AUDIO = "livi_active_audio_call_channel"
        private const val NOTIFICATION_ID = 1004
        private const val EXTRA_PARTNER_NICK = "partnerNick"
        private const val EXTRA_AUDIO_ONLY = "audioOnly"

        fun start(context: Context, partnerNick: String?, audioOnly: Boolean = false) {
            val intent = Intent(context, ActiveCallForegroundService::class.java).apply {
                putExtra(EXTRA_PARTNER_NICK, partnerNick?.takeIf { it.isNotBlank() } ?: "")
                putExtra(EXTRA_AUDIO_ONLY, audioOnly)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            android.util.Log.d(TAG, "ActiveCallForegroundService started partnerNick=${partnerNick?.take(20)}")
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ActiveCallForegroundService::class.java))
            android.util.Log.d(TAG, "ActiveCallForegroundService stop requested")
        }
    }
}
