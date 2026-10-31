package com.kolt12max.livi

/** The call owns PiP eligibility; an individual React screen may unmount during a handoff. */
internal object SystemPiPAutoEnterPolicy {
  fun isArmed(requestedByUi: Boolean, activeCall: Boolean, endingCall: Boolean): Boolean =
    !endingCall && (requestedByUi || activeCall)

  fun isEnabled(
    allowedByActivity: Boolean,
    armed: Boolean,
    inRecents: Boolean,
    returningFromPiP: Boolean,
  ): Boolean = allowedByActivity && armed && !inRecents && !returningFromPiP
}
