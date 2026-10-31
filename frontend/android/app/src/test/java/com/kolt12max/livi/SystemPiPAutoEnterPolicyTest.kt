package com.kolt12max.livi

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemPiPAutoEnterPolicyTest {
  @Test fun screenCleanupDuringInAppHandoffKeepsTheCallArmed() {
    assertTrue(SystemPiPAutoEnterPolicy.isArmed(true, true, false))
    // VideoCall unmounts after the internal PiP has mounted; the same call continues.
    assertTrue(SystemPiPAutoEnterPolicy.isArmed(false, true, false))
    // Service teardown must clear eligibility even if no further UI setter runs.
    assertFalse(SystemPiPAutoEnterPolicy.isArmed(false, false, false))
  }

  @Test fun hangupDisarmsBeforeTheForegroundServiceStops() {
    assertFalse(SystemPiPAutoEnterPolicy.isArmed(true, true, true))
  }

  @Test fun uiCanArmBeforeTheForegroundServiceStarts() {
    assertTrue(SystemPiPAutoEnterPolicy.isArmed(true, false, false))
  }

  @Test fun aLateBridgeRefreshCannotReenterWhileExpandingPiP() {
    val armed = SystemPiPAutoEnterPolicy.isArmed(false, true, false)
    assertFalse(SystemPiPAutoEnterPolicy.isEnabled(true, armed, false, true))
    assertTrue(SystemPiPAutoEnterPolicy.isEnabled(true, armed, false, false))
  }

  @Test fun explicitActivityAndRecentsGatesStillWin() {
    assertFalse(SystemPiPAutoEnterPolicy.isEnabled(false, true, false, false))
    assertFalse(SystemPiPAutoEnterPolicy.isEnabled(true, true, true, false))
    assertFalse(SystemPiPAutoEnterPolicy.isEnabled(true, false, false, false))
  }
}
