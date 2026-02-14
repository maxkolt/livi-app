package com.kolt12max.livi

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Нативный модуль: moveTaskToBack после decline; хранение installId и serverUrl
 * для отклонения звонка по HTTP из IncomingCallActivity без открытия приложения;
 * запуск/закрытие нативного экрана исходящего звонка (OutgoingCallActivity).
 */
class LiviAppModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun launchOutgoingCallActivity(callId: String, toUserId: String, toNick: String?) {
    val ctx = reactApplicationContext
    LiviOngoingCallHelper.setOutgoingCall(ctx, callId, toUserId, toNick ?: "")
    val intent = Intent(ctx, OutgoingCallActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
      putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
      putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick ?: "")
    }
    ctx.startActivity(intent)
  }

  @ReactMethod
  fun closeOutgoingCallActivity() {
    LiviOngoingCallHelper.clearOngoingCall(reactApplicationContext)
    reactApplicationContext.sendBroadcast(Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL))
  }

  /** Единый UI входящего: открыть нативный IncomingCallActivity (foreground и из deep link livi://incoming-call). */
  @ReactMethod
  fun launchIncomingCallActivity(callId: String, from: String, fromNick: String?) {
    val ctx = reactApplicationContext
    LiviOngoingCallHelper.setIncomingCall(ctx, callId, from, fromNick ?: "")
    val intent = Intent(ctx, IncomingCallActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
      putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
      putExtra(IncomingCallActivity.EXTRA_FROM, from)
      putExtra(IncomingCallActivity.EXTRA_FROM_NICK, fromNick ?: "")
    }
    ctx.startActivity(intent)
  }

  /** При обработке livi://answer-call — закрыть IncomingCallActivity по callId (если открыта из уведомления). */
  @ReactMethod
  fun sendCallAnsweredBroadcast(callId: String) {
    val intent = Intent(IncomingCallActivity.ACTION_CALL_ANSWERED).apply {
      setPackage(reactApplicationContext.packageName)
      putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
    }
    reactApplicationContext.sendBroadcast(intent)
  }

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

  /** Открыть настройки уведомлений приложения (Android 8+). Пользователь может включить «Полноэкранные уведомления» для входящих звонков. */
  @ReactMethod
  fun openAppNotificationSettings() {
    val ctx = reactApplicationContext
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    } else {
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        setData(android.net.Uri.parse("package:${ctx.packageName}"))
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    }
    try {
      ctx.startActivity(intent)
    } catch (_: Exception) {}
  }

  /** Единый источник таймаута исходящего (мс): JS передаёт при старте, LiviOutgoingCallService читает. */
  @ReactMethod
  fun setOutgoingCallTimeoutMs(ms: Double) {
    val value = ms.toLong().coerceIn(5000L, 120000L)
    reactApplicationContext.getSharedPreferences(PREFS_CALL, Context.MODE_PRIVATE)
      .edit()
      .putLong(KEY_OUTGOING_CALL_TIMEOUT_MS, value)
      .apply()
  }

  companion object {
    const val NAME = "LiviAppModule"
    const val PREFS_NAME = "LiviDeclinePrefs"
    const val PREFS_CALL = "LiviCallPrefs"
    const val KEY_INSTALL_ID = "install_id"
    const val KEY_SERVER_URL = "server_url"
    const val KEY_OUTGOING_CALL_TIMEOUT_MS = "outgoing_call_timeout_ms"
  }
}
