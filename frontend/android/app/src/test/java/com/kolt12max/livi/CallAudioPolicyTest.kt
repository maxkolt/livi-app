package com.kolt12max.livi

import org.junit.Assert.*
import org.junit.Test

class CallAudioPolicyTest {
    @Test fun proximityFollowsCallAndActualRoute() {
        fun enabled(active: Boolean = true, audio: Boolean = true, hold: Boolean = false,
                    communication: Boolean = true, earpiece: Boolean = true) =
            CallAudioPolicy.useProximity(active, audio, hold, communication, earpiece)
        assertTrue(enabled()) // Display/app visibility is deliberately not an input.
        assertFalse(enabled(active = false))
        assertFalse(enabled(audio = false))
        assertFalse(enabled(hold = true))
        assertFalse(enabled(communication = false)) // GSM / stopped audio engine
        assertFalse(enabled(earpiece = false)) // Speaker, BT, wired, or no committed route
        assertTrue(enabled()) // Switching back or resuming the call re-enables proximity.
    }

    @Test fun failedFocusRequestCanRetryInsteadOfKeepingAnUnusableRequestForever() {
        assertTrue(CallVoiceFocusState.NONE.needsRequest)
        val failed = CallVoiceFocusState.fromRequestResult(0)
        assertEquals(CallVoiceFocusState.FAILED, failed)
        assertTrue(failed.needsRequest)
        val retry = CallVoiceFocusState.fromRequestResult(1)
        assertEquals(CallVoiceFocusState.GRANTED, retry)
        assertFalse(retry.needsRequest)
    }

    @Test fun delayedOrLostFocusDoesNotFightAnExternalCall() {
        val delayed = CallVoiceFocusState.fromRequestResult(2)
        assertEquals(CallVoiceFocusState.DELAYED, delayed)
        assertFalse(delayed.needsRequest)
        assertFalse(CallVoiceFocusState.LOST.needsRequest)
    }
}
