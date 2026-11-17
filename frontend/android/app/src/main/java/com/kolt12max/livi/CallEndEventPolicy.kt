package com.kolt12max.livi

/** Terminal push events belong to one call, including while another call is in PiP. */
internal object CallEndEventPolicy {
    fun matchesCurrentCall(eventCallId: String?, currentCallId: String?): Boolean {
        val ended = eventCallId?.trim().orEmpty()
        val current = currentCallId?.trim().orEmpty()
        return ended.isNotEmpty() && current.isNotEmpty() && ended == current
    }
}
