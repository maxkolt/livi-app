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
    private var callId: String = ""
    private var toUserId: String = ""
    private var toNick: String = ""
    private var closeReceiver: BroadcastReceiver? = null

    override fun onCreate() {
        super.onCreate()
        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val broadcastCallId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: ""
                if (broadcastCallId.isEmpty() || broadcastCallId == this@LiviOutgoingCallService.callId) {
                    android.util.Log.d(TAG, "close broadcast received, stopping service callId=$callId")
                    stopSelf()
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

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        callId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: ""
        toUserId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_TO_USER_ID) ?: ""
        toNick = intent?.getStringExtra(OutgoingCallActivity.EXTRA_TO_NICK) ?: ""

        if (callId.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Явно указываем mediaPlayback тип, чтобы FGS logger/state на Android 13+ не ловил рассинхрон.
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), fgsType)
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
            mp.setVolume(0.2f, 0.2f)
            mp.setOnPreparedListener { it.start() }
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
            cancelCallByHttp(callId)
            val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
                setPackage(applicationContext.packageName)
            }
            sendBroadcast(closeIntent)
            stopSelf()
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

        fun start(context: Context, callId: String, toUserId: String, toNick: String) {
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

        fun stop(context: Context) {
            context.stopService(Intent(context, LiviOutgoingCallService::class.java))
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
