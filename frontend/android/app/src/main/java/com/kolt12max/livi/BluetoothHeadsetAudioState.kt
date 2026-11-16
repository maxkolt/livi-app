package com.kolt12max.livi

import android.bluetooth.BluetoothHeadset

internal object BluetoothHeadsetAudioState {
    fun connectedOrNull(state: Int): Boolean? = when (state) {
        BluetoothHeadset.STATE_AUDIO_CONNECTED -> true
        BluetoothHeadset.STATE_AUDIO_DISCONNECTED -> false
        else -> null // CONNECTING and unknown states cannot prove disconnection.
    }
}
