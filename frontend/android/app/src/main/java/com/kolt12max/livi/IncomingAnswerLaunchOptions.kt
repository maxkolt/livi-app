package com.kolt12max.livi

import android.app.ActivityOptions
import android.os.Build
import android.os.Bundle
import android.window.SplashScreen

/**
 * Incoming and answer launches use a solid starting window. Android can inherit
 * the incoming activity's splash style when restoring the existing Main task,
 * even after consuming the answer launch options.
 */
internal fun incomingAnswerLaunchOptions(): Bundle? {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
  return ActivityOptions.makeBasic()
    .setSplashScreenStyle(SplashScreen.SPLASH_SCREEN_STYLE_SOLID_COLOR)
    .toBundle()
}
