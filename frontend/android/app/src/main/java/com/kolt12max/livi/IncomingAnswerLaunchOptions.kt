package com.kolt12max.livi

import android.app.ActivityOptions
import android.os.Build
import android.os.Bundle
import android.window.SplashScreen

/** Answer handoff uses the call background; the ordinary launcher keeps its branded splash. */
internal fun incomingAnswerLaunchOptions(): Bundle? {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
  return ActivityOptions.makeBasic()
    .setSplashScreenStyle(SplashScreen.SPLASH_SCREEN_STYLE_SOLID_COLOR)
    .toBundle()
}
