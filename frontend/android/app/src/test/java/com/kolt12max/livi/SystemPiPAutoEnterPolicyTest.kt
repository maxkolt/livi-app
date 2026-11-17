package com.kolt12max.livi

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SystemPiPAutoEnterPolicyTest {
  @Test fun repeatedVideoModeKeepsTheCleanFrameAcknowledgement() {
    var ready = false // AboutToEnterSystemPiP starts a fresh capture.
    SystemPiPAutoEnterPolicy.captureFrameReadyOverride(false, false)?.let { ready = it }
    assertFalse(ready)
    ready = true // Compact video reports its clean layout.
    repeat(5) {
      SystemPiPAutoEnterPolicy.captureFrameReadyOverride(false, false)?.let { ready = it }
    }
    assertTrue(ready)
    // No write also protects an ACK arriving concurrently with a mode refresh.
    assertNull(SystemPiPAutoEnterPolicy.captureFrameReadyOverride(false, false))
  }

  @Test fun logoToVideoWaitsForANewCleanFrame() {
    assertEquals(false, SystemPiPAutoEnterPolicy.captureFrameReadyOverride(true, false))
  }

  @Test fun audioLogoIsReadyWithoutWaitingForAVideoLayout() {
    assertEquals(true, SystemPiPAutoEnterPolicy.captureFrameReadyOverride(false, true))
    assertEquals(true, SystemPiPAutoEnterPolicy.captureFrameReadyOverride(true, true))
  }

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
