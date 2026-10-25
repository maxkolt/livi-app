package com.kolt12max.livi

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log

/**
 * Не даёт системе снять MODE_IN_COMMUNICATION, пока WebRTC ещё не начал писать микрофон.
 *
 * AudioService (Android 12+) перестаёт учитывать режим связи у приложения, которое ничего
 * не играет и не пишет: на A35 через ~2.4 с режим падал в NORMAL и возвращался, когда
 * запись всё-таки начиналась. WebRTC запускает AudioRecord только после ICE — через
 * 1.8–2.5 с после ответа на хорошей сети, дольше под VPN / через TURN, и снова при
 * переподключении посреди звонка. Каждый такой провал режима — обрыв звука (~350 мс
 * переключения маршрута). Пока звонок LiVi в режиме связи, а своей записи нет, играем
 * тишину потоком VOICE_COMMUNICATION: для системы приложение активно, режим держится.
 *
 * Только Android 12+ и только пока идёт звонок (ActiveCallForegroundService): режим связи
 * чужого звонка (другое приложение) не трогаем.
 */
internal object CallModeKeeper {
    private const val TAG = "CallModeKeeper"
    /** Звонок, который так и не начал запись, не держим бесконечно. */
    private const val MAX_KEEP_MS = 60_000L
    private const val SAMPLE_RATE = 16_000

    private var handler: Handler? = null
    private var audioManager: AudioManager? = null
    // Поля ниже меняются только на потоке handler; track читает и поток записи.
    @Volatile private var track: AudioTrack? = null
    private var writer: Thread? = null
    private var keepingSinceMs = 0L
    private var exhausted = false
    private val capCheck = Runnable { evaluate("cap") }

    fun install(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || handler != null) return
        val am = ctx.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        val h = Handler(HandlerThread(TAG).apply { start() }.looper)
        handler = h
        audioManager = am
        try {
            am.addOnModeChangedListener({ h.post(it) }) { evaluate("mode") }
            am.registerAudioRecordingCallback(object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    evaluate("recording")
                }
            }, h)
        } catch (e: Exception) {
            Log.w(TAG, "install failed", e)
        }
    }

    /** FGS звонка запущен или остановлен. */
    fun onCallForegroundChanged() {
        handler?.post { evaluate("fgs") }
    }

    private fun evaluate(reason: String) {
        val am = audioManager ?: return
        val inLiviCall = am.mode == AudioManager.MODE_IN_COMMUNICATION &&
            LiviAppModule.isActiveCallForegroundRunning() &&
            !LiviAppModule.getEndingCallInProgress()
        if (!inLiviCall) {
            exhausted = false
            stopSilence(reason)
            return
        }
        // getActiveRecordingConfigurations отдаёт приложению только его собственные записи.
        val recording = am.activeRecordingConfigurations.any {
            it.clientAudioSource == MediaRecorder.AudioSource.VOICE_COMMUNICATION
        }
        if (recording || exhausted) {
            stopSilence(reason)
            return
        }
        if (track == null) startSilence(reason)
        if (SystemClock.elapsedRealtime() - keepingSinceMs >= MAX_KEEP_MS) {
            exhausted = true
            stopSilence("cap")
        }
    }

    private fun startSilence(reason: String) {
        val t = try {
            val minBuf = AudioTrack.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
            )
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build(),
                )
                .setBufferSizeInBytes(minBuf * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
                .also { it.play() }
        } catch (e: Exception) {
            Log.w(TAG, "silence start failed ($reason)", e)
            return
        }
        track = t
        keepingSinceMs = SystemClock.elapsedRealtime()
        handler?.postDelayed(capCheck, MAX_KEEP_MS)
        // Блокирующая запись нулей: поток спит, пока буфер полон.
        writer = Thread({
            val zeros = ShortArray(SAMPLE_RATE / 50)
            while (track === t) {
                if (t.write(zeros, 0, zeros.size) < 0) break
            }
        }, "$TAG-writer").apply { start() }
        Log.i(TAG, "holding communication mode with silence ($reason)")
    }

    private fun stopSilence(reason: String) {
        val t = track ?: return
        track = null
        handler?.removeCallbacks(capCheck)
        try {
            t.pause()
            t.flush()
            t.release()
        } catch (_: Exception) {}
        writer = null
        Log.i(TAG, "released silence ($reason) after ${SystemClock.elapsedRealtime() - keepingSinceMs} ms")
    }
}
