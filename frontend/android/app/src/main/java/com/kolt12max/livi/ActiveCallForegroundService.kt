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
import android.os.PowerManager
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
    private var callWakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            // Перезапуск системой после гибели процесса: звонка (JS + WebRTC) уже нет,
            // осталось бы только «вечное» уведомление «Звонок от кого-то».
            stopSelf(startId)
            return START_NOT_STICKY
        }
        partnerNick = intent.getStringExtra(EXTRA_PARTNER_NICK)?.trim()?.takeIf { it.isNotEmpty() }
        audioOnly = intent.getBooleanExtra(EXTRA_AUDIO_ONLY, false)
        val alreadyRunning = instance === this
        if (alreadyRunning) {
            // Уже foreground: повторный start только меняет текст (аудио ↔ видео). Повторный
            // startForeground из фона перепроверил бы тип microphone и снял бы его.
            refreshNotification()
            if (MainActivity.isInForeground) promoteMicrophone(false)
        } else if (!enterForeground()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        instance = this
        LiviAppModule.setActiveCallForegroundRunningStatic(true)
        acquireCallWakeLock()
        if (alreadyRunning) LiviAppModule.maintainActiveCallVoiceAudioStatic(applicationContext)
        else LiviAppModule.beginActiveCallVoiceAudioHoldStatic(applicationContext)
        CallProximityController.start(applicationContext, audioOnly)
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
        return START_NOT_STICKY
    }

    /**
     * phoneCall + microphone: микрофон и приём голоса в фоне (навигатор / другое приложение поверх).
     * Тип microphone Android 14+ выдаёт только «видимому» приложению. Ответ на исходящий,
     * пока LiVi в фоне, или старт посреди перехода Recents/лаунчер бросал SecurityException
     * прямо здесь — процесс и звонок падали. Тогда стартуем с одним phoneCall, а microphone
     * добираем на ближайшем onResume (promoteMicrophoneIfNeeded).
     */
    private fun enterForeground(): Boolean {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification)
            microphoneTypeGranted = true
            return true
        }
        val phoneCall = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    phoneCall or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
                microphoneTypeGranted = true
                return true
            } catch (e: RuntimeException) {
                android.util.Log.w(TAG, "startForeground phoneCall|microphone refused, fallback to phoneCall", e)
            }
        }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, phoneCall)
            microphoneTypeGranted = Build.VERSION.SDK_INT < 34
            if (!microphoneTypeGranted) {
                LiviAppModule.trackAppEventStatic(
                    applicationContext,
                    "fgs_mic_deferred",
                    org.json.JSONObject().put("appForeground", MainActivity.isInForeground).toString(),
                )
            }
            true
        } catch (e: RuntimeException) {
            android.util.Log.e(TAG, "startForeground phoneCall refused", e)
            false
        }
    }

    private fun refreshNotification() {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIFICATION_ID, buildNotification())
        } catch (e: RuntimeException) {
            android.util.Log.w(TAG, "refreshNotification failed", e)
        }
    }

    private fun promoteMicrophone(retryIfRefused: Boolean) {
        if (microphoneTypeGranted || instance !== this) return
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
            microphoneTypeGranted = true
            android.util.Log.d(TAG, "microphone FGS type granted after resume")
        } catch (e: RuntimeException) {
            android.util.Log.w(TAG, "microphone FGS type still refused (retry=$retryIfRefused)", e)
            // onResume приходит чуть раньше, чем система считает uid видимым.
            if (retryIfRefused) {
                audioMaintainHandler.postDelayed({ promoteMicrophone(false) }, PROMOTE_RETRY_MS)
            }
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        cancelAudioMaintainLoop()
        CallProximityController.stop()
        releaseCallWakeLock()
        LiviAppModule.setActiveCallForegroundRunningStatic(false)
        LiviAppModule.endActiveCallVoiceAudioHoldStatic(applicationContext)
        super.onDestroy()
    }

    /**
     * A foreground service keeps the process important, but it does not keep the CPU running after
     * the display is switched off. LiveKit still needs its audio/network threads (and our 12 s audio
     * guard) to run for the whole call, so hold a partial wake lock for exactly the service lifetime.
     * Android releases the lock as a final safety net if the process dies.
     */
    @Suppress("WakelockTimeout")
    private fun acquireCallWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val lock = callWakeLock
                ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, CALL_WAKE_LOCK_TAG).apply {
                    setReferenceCounted(false)
                }
            callWakeLock = lock
            if (!lock.isHeld) {
                lock.acquire()
                android.util.Log.i(TAG, "active-call partial wake lock acquired")
            }
        } catch (e: RuntimeException) {
            android.util.Log.w(TAG, "active-call partial wake lock acquire failed", e)
        }
    }

    private fun releaseCallWakeLock() {
        val lock = callWakeLock ?: return
        callWakeLock = null
        try {
            if (lock.isHeld) {
                lock.release()
                android.util.Log.i(TAG, "active-call partial wake lock released")
            }
        } catch (e: RuntimeException) {
            android.util.Log.w(TAG, "active-call partial wake lock release failed", e)
        }
    }

    private fun scheduleAudioMaintainLoop() {
        cancelAudioMaintainLoop()
        val r = object : Runnable {
            override fun run() {
                try {
                    LiviAppModule.maintainActiveCallVoiceAudioStatic(applicationContext)
                } catch (_: Exception) {}
                CallRouteGuard.requestCheck("maintain")
                CallProximityController.refresh()
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
    /** FGS уже с типом microphone (или он не нужен до Android 14). */
    @Volatile private var microphoneTypeGranted = false

    private fun buildNotification(): Notification {
        val channelId = if (audioOnly) CHANNEL_ID_AUDIO else CHANNEL_ID
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channelName = if (audioOnly) {
                AppLocale.str(applicationContext, R.string.active_audio_call_notification_channel)
            } else {
                AppLocale.str(applicationContext, R.string.active_call_notification_channel)
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
                AppLocale.str(applicationContext, R.string.active_audio_call_notification_title_from, partnerNick)
            } else {
                AppLocale.str(applicationContext, R.string.active_audio_call_notification_title_someone)
            }
        } else if (!partnerNick.isNullOrEmpty()) {
            AppLocale.str(applicationContext, R.string.active_call_notification_title_from, partnerNick)
        } else {
            AppLocale.str(applicationContext, R.string.active_call_notification_title_someone)
        }

        val contentText = if (audioOnly) {
            AppLocale.str(applicationContext, R.string.active_audio_call_notification_text)
        } else {
            AppLocale.str(applicationContext, R.string.active_call_notification_text)
        }

        // Dumb return: только «вернуть к звонку». Audio vs video UI решает JS по живому состоянию.
        val pendingIntent = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_RETURN_TO_ACTIVE_CALL, true)
                putExtra(MainActivity.EXTRA_RETURN_TO_ACTIVE_CALL_AUDIO_ONLY, false)
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
        private const val CALL_WAKE_LOCK_TAG = "LiVi:ActiveCall"
        private const val AUDIO_MAINTAIN_INTERVAL_MS = 12_000L
        private const val CHANNEL_ID = "livi_active_call_channel"
        private const val CHANNEL_ID_AUDIO = "livi_active_audio_call_channel"
        private const val NOTIFICATION_ID = 1004
        private const val EXTRA_PARTNER_NICK = "partnerNick"
        private const val EXTRA_AUDIO_ONLY = "audioOnly"
        private const val START_DEDUP_MS = 900L
        private const val PROMOTE_RETRY_MS = 600L

        @Volatile private var lastStartSignature: String? = null
        @Volatile private var lastStartAtMs: Long = 0L
        @Volatile private var instance: ActiveCallForegroundService? = null

        /** MainActivity.onResume: LiVi снова на экране — добрать тип microphone, если старт был из фона. */
        fun promoteMicrophoneIfNeeded() {
            val svc = instance ?: return
            if (svc.microphoneTypeGranted) return
            svc.audioMaintainHandler.post { svc.promoteMicrophone(true) }
        }

        fun start(context: Context, partnerNick: String?, audioOnly: Boolean = false) {
            val nick = partnerNick?.takeIf { it.isNotBlank() } ?: ""
            val signature = "${if (audioOnly) "a" else "v"}|$nick"
            val now = System.currentTimeMillis()
            synchronized(ActiveCallForegroundService::class.java) {
                if (signature == lastStartSignature && now - lastStartAtMs < START_DEDUP_MS) {
                    return
                }
                lastStartSignature = signature
                lastStartAtMs = now
            }
            val intent = Intent(context, ActiveCallForegroundService::class.java).apply {
                putExtra(EXTRA_PARTNER_NICK, nick)
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
            synchronized(ActiveCallForegroundService::class.java) {
                lastStartSignature = null
                lastStartAtMs = 0L
            }
            context.stopService(Intent(context, ActiveCallForegroundService::class.java))
            android.util.Log.d(TAG, "ActiveCallForegroundService stop requested")
        }
    }
}
