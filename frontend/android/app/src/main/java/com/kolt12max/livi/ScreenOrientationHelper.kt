package com.kolt12max.livi

import android.app.Activity
import android.content.pm.ActivityInfo

/**
 * All app screens can rotate and be resized.
 *
 * Orientation must be unrestricted both for large-screen compatibility and so the
 * React Native layouts can adapt consistently in split-screen and on foldables.
 */
object ScreenOrientationHelper {
  fun applyPhonePortraitTabletAny(activity: Activity) {
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  }
}
