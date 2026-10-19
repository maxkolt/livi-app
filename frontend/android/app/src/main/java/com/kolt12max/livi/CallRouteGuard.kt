package com.kolt12max.livi

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.Executor

/**
 * Держит встроенный маршрут звонка (ухо / громкая), который JS последним применил явно.
 *
 * InCallManager и LiviAppModule берут AudioManager из одного application context, а у
 * AudioService это один и тот же клиент маршрута. Любой setSpeakerphoneOn(false) /
 * clearCommunicationDevice() из InCallManager (EARPIECE в automatic-режиме, stop/start,
 * его очередь на UI-потоке, отстающая от нативного apply) снимал и громкую LiVi: голос
 * уходил в ухо, а кнопка оставалась на «громкой». Guard возвращает выбранный маршрут, если
 * система увела звонок на другой встроенный. BT / провод / USB решает JS — тогда guard молчит.
 *
 * Работает только пока идёт звонок (ActiveCallForegroundService) и только на Android 12+.
 * Все поля трогаются на audio-route потоке LiviAppModule.
 */
internal object CallRouteGuard {
    private const val TAG = "CallRouteGuard"
    /** Даём переключениям (BT, PiP, ICM-очередь) устояться, прежде чем решать. */
    private const val SETTLE_MS = 350L
    private const val MIN_RESTORE_GAP_MS = 1500L
    private const val MAX_RESTORES_PER_CALL = 20

    /** Пишется на audio-route потоке, читается и из main (disarm при остановке FGS). */
    @Volatile private var handler: Handler? = null
    private var audioManager: AudioManager? = null
    private var appContext: Context? = null
    private var desiredType: Int? = null
    private var listener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var pendingCheck: Runnable? = null
    private var lastRestoreAtMs = 0L
    private var restoresThisCall = 0

    /** setVoiceCall*: JS применил встроенный маршрут. Вызывать на audio-route потоке. */
    fun onBuiltinRouteApplied(ctx: Context, routeHandler: Handler, route: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        // До старта FGS и во время завершения — это не выбор текущего звонка.
        if (!LiviAppModule.isActiveCallForegroundRunning() || LiviAppModule.getEndingCallInProgress()) return
        val type = when (route) {
            "SPEAKER_PHONE" -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            "EARPIECE" -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            else -> return
        }
        handler = routeHandler
        appContext = ctx.applicationContext
        // Тот же AudioManager (и тот же клиент маршрута), что у LiviAppModule и InCallManager:
        // следующий явный выбор JS и clear из InCallManager.stop() заменяют восстановленный маршрут.
        val am = audioManager
            ?: (ctx.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)
            ?: return
        audioManager = am
        desiredType = type
        registerListener(am, routeHandler)
    }

    /** setVoiceCall*: JS увёл звонок на BT / провод — маршрутом управляет JS. */
    fun onExternalRouteApplied() {
        handler?.post { desiredType = null }
    }

    /** Подстраховка на случай пропущенного события (12 с цикл ActiveCallForegroundService). */
    fun requestCheck(reason: String) {
        handler?.post { scheduleCheck(reason, 0L) }
    }

    /** Звонок закончился (FGS остановлен). */
    fun disarm() {
        val h = handler ?: return
        h.post {
            pendingCheck?.let { h.removeCallbacks(it) }
            pendingCheck = null
            desiredType = null
            restoresThisCall = 0
            lastRestoreAtMs = 0L
            unregisterListener()
        }
    }

    private fun registerListener(am: AudioManager, routeHandler: Handler) {
        if (listener != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val l = AudioManager.OnCommunicationDeviceChangedListener { scheduleCheck("device_changed", SETTLE_MS) }
        try {
            am.addOnCommunicationDeviceChangedListener(Executor { routeHandler.post(it) }, l)
            listener = l
        } catch (e: Exception) {
            Log.w(TAG, "addOnCommunicationDeviceChangedListener failed", e)
        }
    }

    private fun unregisterListener() {
        val l = listener ?: return
        listener = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        try {
            audioManager?.removeOnCommunicationDeviceChangedListener(l)
        } catch (_: Exception) {}
    }

    private fun scheduleCheck(reason: String, delayMs: Long) {
        val h = handler ?: return
        pendingCheck?.let { h.removeCallbacks(it) }
        val r = Runnable {
            pendingCheck = null
            check(reason)
        }
        pendingCheck = r
        h.postDelayed(r, delayMs)
    }

    private fun check(reason: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val target = desiredType ?: return
        val am = audioManager ?: return
        if (!LiviAppModule.isActiveCallForegroundRunning() || LiviAppModule.getEndingCallInProgress()) return
        try {
            // GSM / входящий / завершение: режим не наш — маршрут не трогаем.
            if (am.mode != AudioManager.MODE_IN_COMMUNICATION) return
            val current = am.communicationDevice?.type
            if (current == target) return
            if (current != null && !isBuiltinType(current)) return
            val available = am.availableCommunicationDevices
            if (available.any { !isBuiltinType(it.type) }) return
            val now = SystemClock.elapsedRealtime()
            if (restoresThisCall >= MAX_RESTORES_PER_CALL) return
            val sinceLast = now - lastRestoreAtMs
            if (lastRestoreAtMs > 0L && sinceLast < MIN_RESTORE_GAP_MS) {
                scheduleCheck(reason, MIN_RESTORE_GAP_MS - sinceLast)
                return
            }
            val device = available.firstOrNull { it.type == target } ?: return
            val ok = am.setCommunicationDevice(device)
            restoresThisCall++
            lastRestoreAtMs = now
            Log.w(TAG, "restored ${routeName(target)} (system had ${routeName(current)}) reason=$reason ok=$ok n=$restoresThisCall")
            appContext?.let { ctx ->
                LiviAppModule.trackAppEventStatic(
                    ctx,
                    "call_route_restored",
                    org.json.JSONObject()
                        .put("want", routeName(target))
                        .put("had", routeName(current))
                        .put("reason", reason)
                        .put("appForeground", MainActivity.isInForeground)
                        .toString(),
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "check failed", e)
        }
    }

    private fun isBuiltinType(type: Int): Boolean =
        type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE ||
            type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER ||
            type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE

    private fun routeName(type: Int?): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "SPEAKER_PHONE"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "EARPIECE"
        null -> "none"
        else -> "type$type"
    }
}
