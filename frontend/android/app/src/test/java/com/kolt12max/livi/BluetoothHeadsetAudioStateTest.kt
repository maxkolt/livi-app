package com.kolt12max.livi

import android.bluetooth.BluetoothHeadset
import org.junit.Assert.*
import org.junit.Test

class BluetoothHeadsetAudioStateTest {
    @Test fun reconnectDoesNotEmitAnUnplugWhileScoStarts() {
        val published = listOf(
            BluetoothHeadset.STATE_AUDIO_CONNECTING,
            BluetoothHeadset.STATE_AUDIO_CONNECTED,
            BluetoothHeadset.STATE_AUDIO_CONNECTING,
            BluetoothHeadset.STATE_AUDIO_CONNECTED,
        ).mapNotNull(BluetoothHeadsetAudioState::connectedOrNull)
        assertEquals(listOf(true, true), published)
    }

    @Test fun realDisconnectStillPublishesImmediately() {
        assertEquals(false, BluetoothHeadsetAudioState.connectedOrNull(BluetoothHeadset.STATE_AUDIO_DISCONNECTED))
        assertNull(BluetoothHeadsetAudioState.connectedOrNull(-1))
    }
}
