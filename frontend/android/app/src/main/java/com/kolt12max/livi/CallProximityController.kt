package com.kolt12max.livi

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.Executor

/** The active-call service owns proximity, independently of Activity/JS visibility. */
internal object CallProximityController {
    private const val TAG = "LiViProximity"
    private val handler = Handler(Looper.getMainLooper())
    private var audioManager: AudioManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioOnly = false
    private var externalHold = false
    private var routeListener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var modeListener: AudioManager.OnModeChangedListener? = null
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
    }

    fun start(context: Context, isAudioOnly: Boolean) = onMain {
        audioOnly = isAudioOnly
        if (audioManager == null) {
            val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                ?: return@onMain
            val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
                ?: return@onMain
            if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                Log.i(TAG, "proximity screen-off wake lock unsupported")
                return@onMain
            }
            audioManager = am
            wakeLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "LiVi:CallProximity")
                .apply { setReferenceCounted(false) }
            try {
                am.registerAudioDeviceCallback(deviceCallback, handler)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val listener = AudioManager.OnCommunicationDeviceChangedListener { refresh() }
                    routeListener = listener
                    am.addOnCommunicationDeviceChangedListener(Executor { handler.post(it) }, listener)
                    val mode = AudioManager.OnModeChangedListener { refresh() }
                    modeListener = mode
                    am.addOnModeChangedListener(Executor { handler.post(it) }, mode)
                }
            } catch (e: RuntimeException) { Log.w(TAG, "route observation failed", e) }
        }
        reconcile()
    }

    fun setExternalHold(active: Boolean) = onMain {
        externalHold = active
        reconcile()
    }

    fun refresh() = onMain { reconcile() }

    @Suppress("DEPRECATION", "WakelockTimeout")
    private fun reconcile() {
        val am = audioManager ?: return
        val lock = wakeLock ?: return
        try {
            val earpiece = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            } else {
                !am.isSpeakerphoneOn && !am.isBluetoothScoOn && !am.isWiredHeadsetOn &&
                    am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                        .any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE } &&
                    am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none {
                        it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_DEVICE
                    }
            }
            val enabled = CallAudioPolicy.useProximity(
                LiviAppModule.isActiveCallForegroundRunning(), audioOnly, externalHold,
                am.mode == AudioManager.MODE_IN_COMMUNICATION, earpiece,
            )
            if (enabled && !lock.isHeld) {
                // Android handles both near AND far, even while JS is paused. This does not
                // wake a phone put to sleep with its power button or change any audio route.
                lock.acquire()
                Log.i(TAG, "enabled: audio call on earpiece")
            } else if (!enabled && lock.isHeld) {
                lock.release()
                Log.i(TAG, "disabled: route, media or hold changed")
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "proximity update failed", e)
        }
    }

    fun stop() = onMain {
        val am = audioManager
        audioManager = null
        audioOnly = false
        externalHold = false
        try { am?.unregisterAudioDeviceCallback(deviceCallback) } catch (_: RuntimeException) {}
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try { routeListener?.let { am?.removeOnCommunicationDeviceChangedListener(it) } }
            catch (_: RuntimeException) {}
            try { modeListener?.let { am?.removeOnModeChangedListener(it) } }
            catch (_: RuntimeException) {}
        }
        routeListener = null
        modeListener = null
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: RuntimeException) {}
        wakeLock = null
        Log.i(TAG, "stopped")
    }
}
