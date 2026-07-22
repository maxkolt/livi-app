package com.kolt12max.livi

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration

/**
 * Phones stay portrait; tablets / large screens (sw >= 600dp) can rotate freely.
 *
 * Android 16 (targetSdk 36): on large screens the platform ignores forced orientation /
 * non-resizable restrictions. We already leave tablets unrestricted, which matches
 * the new policy and avoids letterboxing on foldables / tablets.
 */
object ScreenOrientationHelper {
  private const val TABLET_SMALLEST_WIDTH_DP = 600

  fun isTablet(activity: Activity): Boolean {
    val cfg = activity.resources.configuration
    if (cfg.smallestScreenWidthDp >= TABLET_SMALLEST_WIDTH_DP) return true
    val size = cfg.screenLayout and Configuration.SCREENLAYOUT_SIZE_MASK
    return size == Configuration.SCREENLAYOUT_SIZE_LARGE ||
      size == Configuration.SCREENLAYOUT_SIZE_XLARGE
  }

  fun applyPhonePortraitTabletAny(activity: Activity) {
    // Large-screen devices: leave unrestricted (required behavior when targeting API 36).
    if (isTablet(activity)) {
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      return
    }
    // Phones: portrait remains valid under API 36 (restrictions are ignored only on large screens).
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
  }
}
