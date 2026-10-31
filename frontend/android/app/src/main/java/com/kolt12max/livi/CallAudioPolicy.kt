package com.kolt12max.livi

/** No Activity visibility: a locked display must not change the lifetime of a call. */
internal object CallAudioPolicy {
    fun useProximity(active: Boolean, audioOnly: Boolean, externalHold: Boolean,
                     communicationMode: Boolean, earpiece: Boolean): Boolean =
        active && audioOnly && !externalHold && communicationMode && earpiece
}

/** A request object is not evidence of granted focus. Lost/delayed focus waits for Android;
 * failed requests may be retried by the service, without fighting another call for focus. */
internal enum class CallVoiceFocusState {
    NONE, GRANTED, DELAYED, LOST, FAILED;

    val needsRequest: Boolean get() = this == NONE || this == FAILED

    companion object {
        fun fromRequestResult(result: Int): CallVoiceFocusState = when (result) {
            1 -> GRANTED // AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            2 -> DELAYED // AudioManager.AUDIOFOCUS_REQUEST_DELAYED
            else -> FAILED
        }
    }
}
