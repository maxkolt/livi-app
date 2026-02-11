package com.kolt12max.livi

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Нативный модуль: moveTaskToBack после decline; хранение installId и serverUrl
 * для отклонения звонка по HTTP из IncomingCallActivity без открытия приложения.
 */
class LiviAppModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun moveTaskToBack(nonRoot: Boolean) {
    val activity = currentActivity ?: return
    activity.runOnUiThread {
      activity.moveTaskToBack(nonRoot)
    }
  }

  @ReactMethod
  fun setInstallIdForDecline(installId: String?) {
    if (installId.isNullOrBlank()) return
    reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_INSTALL_ID, installId)
      .apply()
  }

  @ReactMethod
  fun setServerUrlForDecline(url: String?) {
    if (url.isNullOrBlank()) return
    reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_SERVER_URL, url.trim().removeSuffix("/"))
      .apply()
  }

  companion object {
    const val NAME = "LiviAppModule"
    const val PREFS_NAME = "LiviDeclinePrefs"
    const val KEY_INSTALL_ID = "install_id"
    const val KEY_SERVER_URL = "server_url"
  }
}
