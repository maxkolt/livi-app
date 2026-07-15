package com.kolt12max.livi

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration

/**
 * Phones stay portrait; tablets (sw >= 600dp or large/xlarge) can rotate freely.
 * Manifest uses unspecified so we can set this per device at runtime.
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
    activity.requestedOrientation =
      if (isTablet(activity)) {
        ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      } else {
        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      }
  }
}
