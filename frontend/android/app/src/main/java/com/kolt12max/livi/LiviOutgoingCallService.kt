package com.kolt12max.livi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.net.URL

/**
 * Foreground-сервис исходящего вызова: воспроизводит WAV в верхнем динамике в фоне,
 * показывает уведомление «LiVi — видеозвонок», по тапу открывает OutgoingCallActivity.
 * Через 20 сек бездействия отменяет вызов по HTTP и останавливается.
 */
class LiviOutgoingCallService : Service() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var mediaPlayer: MediaPlayer? = null
    private var timeoutRunnable: Runnable? = null
    private var savedAudioMode: Int = AudioManager.MODE_NORMAL
    private var savedSpeakerphone: Boolean = false
    private var ringbackAudioFocusRequest: AudioFocusRequest? = null
    private var callId: String = ""
    private var toUserId: String = ""
    private var toNick: String = ""
    private var closeReceiver: BroadcastReceiver? = null
    @Volatile
    private var foregroundStarted: Boolean = false
    @Volatile
    private var pendingStopAfterForeground: Boolean = false

    override fun onCreate() {
        super.onCreate()
        // Receiver регистрируем после первого startForeground в onStartCommand.
    }

    private fun registerCloseReceiverIfNeeded() {
        if (closeReceiver != null) return
        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val broadcastCallId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: ""
                val forceClose = intent?.getBooleanExtra(OutgoingCallActivity.EXTRA_FORCE_CLOSE, false) == true
                // Пустой broadcast без force больше НЕ гасит активный ringback:
                // late onDestroy старого OutgoingCallActivity иначе убивает мелодию нового дозвона.
                val shouldStop =
                    (broadcastCallId.isNotEmpty() && broadcastCallId == this@LiviOutgoingCallService.callId) ||
                        (forceClose && broadcastCallId.isEmpty()) ||
                        (broadcastCallId.isEmpty() && this@LiviOutgoingCallService.callId.isEmpty())
                if (shouldStop) {
                    android.util.Log.d(
                        TAG,
                        "close broadcast stopping service callId=$callId broadcastCallId=$broadcastCallId force=$forceClose",
                    )
                    requestStop()
                } else {
                    android.util.Log.d(
                        TAG,
                        "close broadcast ignored broadcastCallId=$broadcastCallId currentCallId=$callId force=$forceClose",
                    )
                }
            }
        }
        val filter = IntentFilter(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(closeReceiver, filter)
        }
    }

    /** Android: после startForegroundService() обязан быть startForeground до stopSelf. */
    private fun ensureForegroundStarted() {
        if (foregroundStarted) return
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), fgsType)
        foregroundStarted = true
    }

    private fun requestStop() {
        if (!foregroundStarted) {
            pendingStopAfterForeground = true
            return
        }
        stopForegroundAndSelf()
    }

    private fun stopForegroundAndSelf() {
        markNotRinging()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {}
        stopSelf()
    }

    private fun markRinging(id: String) {
        ringingCallId = id.trim()
        ringingActive = true
    }

    private fun markNotRinging() {
        ringingActive = false
        ringingCallId = ""
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForegroundStarted()
        registerCloseReceiverIfNeeded()

        callId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: ""
        toUserId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_TO_USER_ID) ?: ""
        toNick = intent?.getStringExtra(OutgoingCallActivity.EXTRA_TO_NICK) ?: ""

        if (pendingStopAfterForeground || callId.isEmpty()) {
            android.util.Log.d(
                TAG,
                "onStartCommand: stop after foreground pendingStop=$pendingStopAfterForeground emptyCallId=${callId.isEmpty()}",
            )
            pendingStopAfterForeground = false
            markNotRinging()
            stopForegroundAndSelf()
            return START_NOT_STICKY
        }

        markRinging(callId)
        startSound()
        scheduleTimeout()

        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        // Use a new channel id so previously created noisy channel settings do not persist.
        val channelId = "livi_outgoing_call_channel_v2"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                getString(R.string.outgoing_call_notification_channel),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                setShowBadge(true)
                setSound(null, null)
                enableVibration(false)
                setVibrationPattern(longArrayOf(0))
            }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }

        val pendingIntent = LiviOngoingCallHelper.getPendingIntent(this)
            ?: PendingIntent.getActivity(
                this,
                NOTIFICATION_ID,
                Intent(this, OutgoingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, this@LiviOutgoingCallService.toUserId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_NICK, this@LiviOutgoingCallService.toNick)
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle(getString(R.string.outgoing_call_notification_title))
            .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_menu_call)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSilent(true)
            .build()
    }

    private fun acquireRingbackAudioFocus(am: AudioManager) {
        try {
            releaseRingbackAudioFocus(am)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener { }
                    .build()
                ringbackAudioFocusRequest = req
                if (am.requestAudioFocus(req) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    android.util.Log.w(TAG, "ringback audio focus not granted")
                }
            } else {
                @Suppress("DEPRECATION")
                if (am.requestAudioFocus(
                        null,
                        AudioManager.STREAM_VOICE_CALL,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
                    ) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                ) {
                    android.util.Log.w(TAG, "ringback audio focus not granted (legacy)")
                }
            }
        } catch (e: Exception) {
            android.util.Log.w(TAG, "acquireRingbackAudioFocus failed", e)
        }
    }

    private fun releaseRingbackAudioFocus(am: AudioManager? = null) {
        val audioManager = am ?: try {
            getSystemService(Context.AUDIO_SERVICE) as AudioManager
        } catch (_: Exception) {
            null
        } ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ringbackAudioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
                ringbackAudioFocusRequest = null
            } else {
                @Suppress("DEPRECATION")
                audioManager.abandonAudioFocus(null)
            }
        } catch (_: Exception) {}
    }

    private fun startSound() {
        try {
            mediaPlayer?.apply {
                try {
                    if (isPlaying) stop()
                    release()
                } catch (_: Exception) {}
            }
            mediaPlayer = null

            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            savedAudioMode = am.mode
            savedSpeakerphone = am.isSpeakerphoneOn
            // После предыдущего LiveKit/WebRTC часто остаётся чужой focus — без reclaim мелодия
            // дозвона на redial не слышна в earpiece.
            acquireRingbackAudioFocus(am)
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = false

            val mp = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                setOnErrorListener { _, what, extra ->
                    android.util.Log.w(TAG, "MediaPlayer error what=$what extra=$extra")
                    true
                }
            }
            resources.openRawResourceFd(R.raw.phone_calling_1b).use { afd ->
                mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            }
            mp.isLooping = true
            mp.setVolume(0.35f, 0.35f)
            mp.setOnPreparedListener { player ->
                try {
                    am.mode = AudioManager.MODE_IN_COMMUNICATION
                    am.isSpeakerphoneOn = false
                } catch (_: Exception) {}
                player.start()
            }
            mp.prepareAsync()
            mediaPlayer = mp
        } catch (e: Exception) {
            android.util.Log.w(TAG, "startSound failed", e)
        }
    }

    private fun scheduleTimeout() {
        val timeoutMs = applicationContext.getSharedPreferences(LiviAppModule.PREFS_CALL, Context.MODE_PRIVATE)
            .getLong(LiviAppModule.KEY_OUTGOING_CALL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        timeoutRunnable = Runnable {
            timeoutRunnable = null
            val id = callId
            if (id.isNotEmpty()) {
                EndedCallIds.add(applicationContext, id)
                LiviOngoingCallHelper.clearOngoingCallIfMatches(applicationContext, id)
            }
            cancelCallByHttp(id)
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(applicationContext.packageName)
                if (id.isNotEmpty()) {
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, id)
                }
            }
            sendBroadcast(closeIntent)
            requestStop()
        }
        mainHandler.postDelayed(timeoutRunnable!!, timeoutMs)
    }

    private fun cancelCallByHttp(callId: String) {
        if (callId.isEmpty()) return
        val prefs = applicationContext.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
        val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
        val serverUrl = LiviAppModule.resolveServerBaseUrl(applicationContext)
        if (installId == null || serverUrl == null) return
        Thread {
            try {
                val url = URL("$serverUrl/api/calls/cancel")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("x-install-id", installId)
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.outputStream.use { os ->
                    os.write("{\"callId\":\"${callId.replace("\"", "\\\"")}\"}".toByteArray(Charsets.UTF_8))
                }
                conn.responseCode
                conn.disconnect()
            } catch (e: Exception) {
                android.util.Log.w(TAG, "cancel HTTP failed", e)
            }
        }.start()
    }

    override fun onDestroy() {
        markNotRinging()
        closeReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        closeReceiver = null
        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        timeoutRunnable = null
        try {
            mediaPlayer?.apply {
                if (isPlaying) stop()
                release()
            }
        } catch (_: Exception) {}
        mediaPlayer = null
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            releaseRingbackAudioFocus(am)
            am.mode = savedAudioMode
            am.isSpeakerphoneOn = savedSpeakerphone
        } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "LiviOutgoingCallService"
        private const val NOTIFICATION_ID = 1003
        private const val DEFAULT_TIMEOUT_MS = 27_000L

        @Volatile
        private var ringingActive: Boolean = false
        @Volatile
        private var ringingCallId: String = ""

        /** Живой дозвон (сервис играет ringback). Без этого prefs не должны поднимать Outgoing с лаунчера. */
        @JvmStatic
        fun isRingingActive(callId: String? = null): Boolean {
            if (!ringingActive) return false
            val want = callId?.trim().orEmpty()
            if (want.isEmpty()) return true
            return ringingCallId == want
        }

        fun start(context: Context, callId: String, toUserId: String, toNick: String) {
            if (callId.isBlank()) {
                android.util.Log.w(TAG, "start skipped: empty callId")
                return
            }
            val intent = Intent(context, LiviOutgoingCallService::class.java).apply {
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
                putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Закрытие через broadcast — сервис сам stopSelf после startForeground.
         * Без callId — no-op: иначе late onDestroy/unscoped stop гасит ringback нового redial.
         */
        fun stop(context: Context, callId: String? = null) {
            val id = callId?.trim().orEmpty()
            if (id.isEmpty()) {
                android.util.Log.d(TAG, "stop skipped: empty callId (avoid killing redial ringback)")
                return
            }
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(context.packageName)
                putExtra(OutgoingCallActivity.EXTRA_CALL_ID, id)
            }
            try {
                context.sendBroadcast(closeIntent)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "stop broadcast failed", e)
            }
        }

        /** Уведомить сервер об отмене вызова (при нажатии «Отмена» на экране). */
        fun cancelCallOnServer(context: Context, callId: String) {
            if (callId.isEmpty()) return
            val prefs = context.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
            val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
            val serverUrl = LiviAppModule.resolveServerBaseUrl(context)
            if (installId == null || serverUrl == null) return
            Thread {
                try {
                    val url = URL("$serverUrl/api/calls/cancel")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("x-install-id", installId)
                    conn.doOutput = true
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.outputStream.use { os ->
                        os.write("{\"callId\":\"${callId.replace("\"", "\\\"")}\"}".toByteArray(Charsets.UTF_8))
                    }
                    conn.responseCode
                    conn.disconnect()
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "cancelCallOnServer failed", e)
                }
            }.start()
        }
    }
}
