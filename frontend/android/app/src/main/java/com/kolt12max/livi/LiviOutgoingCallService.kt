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
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.net.URL
import java.lang.ref.WeakReference

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
    /** pending_* до adopt — чтобы CLOSE/cancel с provisional id всё ещё стопал сервис. */
    private var provisionalCallId: String = ""
    private var closeReceiver: BroadcastReceiver? = null
    @Volatile
    private var foregroundStarted: Boolean = false
    @Volatile
    private var pendingStopAfterForeground: Boolean = false

    override fun onCreate() {
        super.onCreate()
        instanceRef = WeakReference(this)
        // Receiver регистрируем после первого startForeground в onStartCommand.
    }

    private fun registerCloseReceiverIfNeeded() {
        if (closeReceiver != null) return
        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val broadcastCallId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: ""
                val forceClose = intent?.getBooleanExtra(OutgoingCallActivity.EXTRA_FORCE_CLOSE, false) == true
                val shouldStop =
                    forceClose ||
                        callIdsMatchForStop(broadcastCallId, this@LiviOutgoingCallService.callId, provisionalCallId) ||
                        (broadcastCallId.isEmpty() && this@LiviOutgoingCallService.callId.isEmpty())
                if (shouldStop) {
                    android.util.Log.d(
                        TAG,
                        "close broadcast stopping service callId=$callId provisional=$provisionalCallId broadcast=$broadcastCallId force=$forceClose",
                    )
                    requestStop()
                } else {
                    android.util.Log.d(
                        TAG,
                        "close broadcast ignored broadcastCallId=$broadcastCallId currentCallId=$callId provisional=$provisionalCallId force=$forceClose",
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
        val adoptOnly = intent?.getBooleanExtra(EXTRA_ADOPT_ONLY, false) == true

        if (adoptOnly && callId.isNotEmpty()) {
            this.callId = callId
            markRinging(callId)
            // Таймаут с реальным callId; звук уже играет с provisional.
            scheduleTimeout()
            android.util.Log.d(TAG, "onStartCommand: adoptOnly callId=${callId.take(24)}")
            return START_NOT_STICKY
        }

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

        if (callId.startsWith("pending_")) {
            provisionalCallId = callId
        } else if (provisionalCallId.isEmpty()) {
            provisionalCallId = ""
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

        // Всегда свежий Intent с актуальным toNick: IMMUTABLE PI от getPendingIntent
        // мог заморозить пустой ник с первого start → тап по уведомлению без ника.
        val contentIntent = Intent(this, OutgoingCallActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
            )
            putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
            putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, this@LiviOutgoingCallService.toUserId)
            putExtra(OutgoingCallActivity.EXTRA_TO_NICK, this@LiviOutgoingCallService.toNick)
            putExtra(OutgoingCallActivity.EXTRA_HAS_VIDEO, true)
        }
        val piFlags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // MUTABLE: UPDATE_CURRENT реально обновляет extras при adoptRealCallId / смене ника.
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
        val pendingIntent = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            contentIntent,
            piFlags,
        )

        val title = if (toNick.isNotBlank()) {
            toNick
        } else {
            getString(R.string.outgoing_call_notification_title)
        }
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle(title)
            .setContentText(getString(R.string.outgoing_call_notification_title))
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

    /** Мгновенно заглушить ringback на main; stop/release — вне критического пути cancel. */
    private fun silencePlayerNow() {
        try {
            mediaPlayer?.setVolume(0f, 0f)
        } catch (_: Exception) {}
        try {
            mediaPlayer?.pause()
        } catch (_: Exception) {}
    }

    private fun releasePlayerAsync() {
        val mp = mediaPlayer
        mediaPlayer = null
        if (mp == null) return
        Thread({
            try {
                if (mp.isPlaying) mp.stop()
            } catch (_: Exception) {}
            try {
                mp.release()
            } catch (_: Exception) {}
        }, "livi-ringback-release").start()
    }

    override fun onDestroy() {
        val t0 = SystemClock.elapsedRealtime()
        markNotRinging()
        closeReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        closeReceiver = null
        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        timeoutRunnable = null
        silencePlayerNow()
        releasePlayerAsync()
        // AudioManager restore НЕ на main: на части OEM mode/focus блокирует тачи на секунды.
        val savedMode = savedAudioMode
        val savedSpeaker = savedSpeakerphone
        Thread({
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                releaseRingbackAudioFocus(am)
                am.mode = savedMode
                am.isSpeakerphoneOn = savedSpeaker
            } catch (_: Exception) {}
            android.util.Log.d(
                TAG,
                "onDestroy audio restore done elapsedMs=${SystemClock.elapsedRealtime() - t0}",
            )
        }, "livi-audio-restore").start()
        android.util.Log.d(TAG, "onDestroy quick exit elapsedMs=${SystemClock.elapsedRealtime() - t0}")
        if (instanceRef?.get() === this) {
            instanceRef = null
        }
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

        private var instanceRef: WeakReference<LiviOutgoingCallService>? = null

        /**
         * Cancel path: mute instantly, then stop FGS (notification).
         * pending_* этого же dial (provisional на сервисе) ↔ real — стопаем.
         * Другой real id (redial) — skip.
         */
        @JvmStatic
        fun silenceAndStop(context: Context, callId: String?) {
            val id = callId?.trim().orEmpty()
            val svc = instanceRef?.get()
            val ringing = ringingCallId.ifBlank { svc?.callId.orEmpty() }
            val provisional = svc?.provisionalCallId.orEmpty()
            if (
                id.isNotEmpty() &&
                ringingActive &&
                ringing.isNotEmpty() &&
                !callIdsMatchForStop(id, ringing, provisional)
            ) {
                android.util.Log.d(
                    TAG,
                    "silenceAndStop: skip stale id=${id.take(24)} ringing=${ringing.take(24)} provisional=${provisional.take(24)}",
                )
                return
            }
            val stopId = when {
                ringing.isNotEmpty() && (id.isEmpty() || callIdsMatchForStop(id, ringing, provisional)) -> ringing
                id.isNotEmpty() -> id
                else -> ""
            }
            silencePlayerOnly()
            forceStopNow(context, stopId)
        }

        /**
         * Снять FGS-уведомление исходящего сразу (cancel / stale tap).
         * Не зависит только от broadcast — instance.requestStop + nm.cancel.
         */
        @JvmStatic
        fun forceStopNow(context: Context, callId: String? = null) {
            val id = callId?.trim().orEmpty()
            try {
                instanceRef?.get()?.requestStop()
            } catch (_: Exception) {}
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(NOTIFICATION_ID)
            } catch (_: Exception) {}
            markNotRingingStatic()
            if (id.isNotEmpty()) {
                stop(context, id)
                try {
                    LiviOngoingCallHelper.clearOngoingCallIfMatches(context, id)
                } catch (_: Exception) {}
            }
            // Снести prefs исходящего, если сервис уже мёртв (stale shade).
            if (!isRingingActive()) {
                try {
                    val type = context.getSharedPreferences("livi_ongoing_call", Context.MODE_PRIVATE)
                        .getString("type", null)
                    if (type == "outgoing") {
                        LiviOngoingCallHelper.clearOngoingCall(context)
                    }
                } catch (_: Exception) {}
            }
            android.util.Log.d(TAG, "forceStopNow callId=${id.take(24)}")
        }

        /**
         * broadcast/cancel id относится к текущему сервису:
         * exact match, или cancel provisional этого dial, или real пока сервис ещё на pending.
         */
        @JvmStatic
        fun callIdsMatchForStop(cancelId: String, serviceCallId: String, serviceProvisional: String): Boolean {
            val x = cancelId.trim()
            val y = serviceCallId.trim()
            val p = serviceProvisional.trim()
            if (x.isEmpty()) return false
            if (y.isNotEmpty() && x == y) return true
            if (p.isNotEmpty() && x == p) return true
            // Cancel уже с real, сервис ещё на pending_ этого же dial
            if (!x.startsWith("pending_") && y.startsWith("pending_") && (p.isEmpty() || p == y)) return true
            return false
        }

        /** Только mute + сброс ringing flag — без stopForeground/broadcast (для мгновенного X). */
        @JvmStatic
        fun silencePlayerOnly() {
            try {
                instanceRef?.get()?.silencePlayerNow()
            } catch (_: Exception) {}
            markNotRingingStatic()
        }

        private fun markNotRingingStatic() {
            ringingActive = false
            ringingCallId = ""
        }

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
         * callId с сервера пришёл после provisional ringback (`pending_*`).
         * Не перезапускаем сервис/звук — только перепривязываем id, иначе redial «думает» до notifyOutgoingCallId.
         */
        @JvmStatic
        fun adoptRealCallId(context: Context, newCallId: String, toUserId: String, toNick: String): Boolean {
            val id = newCallId.trim()
            if (id.isEmpty()) return false
            if (ringingActive && (ringingCallId.startsWith("pending_") || ringingCallId == id)) {
                ringingCallId = id
                android.util.Log.d(TAG, "adoptRealCallId: rebound ringing to ${id.take(24)}")
                // Обновить prefs/notification context без stop/start MediaPlayer.
                try {
                    LiviOngoingCallHelper.setOutgoingCall(context, id, toUserId, toNick)
                } catch (_: Exception) {}
                // Дёрнуть onStartCommand с новым callId, но startSound уже играет —
                // передаём EXTRA_ADOPT_ONLY чтобы не рестартить плеер.
                val intent = Intent(context, LiviOutgoingCallService::class.java).apply {
                    putExtra(OutgoingCallActivity.EXTRA_CALL_ID, id)
                    putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
                    putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick)
                    putExtra(EXTRA_ADOPT_ONLY, true)
                }
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.startForegroundService(intent)
                    } else {
                        context.startService(intent)
                    }
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "adoptRealCallId startService failed", e)
                }
                return true
            }
            return false
        }

        private const val EXTRA_ADOPT_ONLY = "adopt_only"

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
