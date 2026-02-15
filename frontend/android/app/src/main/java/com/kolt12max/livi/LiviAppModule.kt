package com.kolt12max.livi

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * Нативный модуль: moveTaskToBack после decline; хранение installId и serverUrl
 * для отклонения звонка по HTTP из IncomingCallActivity без открытия приложения;
 * запуск/закрытие нативного экрана исходящего звонка (OutgoingCallActivity).
 */
class LiviAppModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  init {
    LiviAppModule.reactContextRef = reactApplicationContext
  }

  override fun getName(): String = NAME

  /** Показать нативный экран исходящего сразу (без callId). callId придёт позже через notifyOutgoingCallId. */
  @ReactMethod
  fun launchOutgoingCallActivityWithoutCallId(toUserId: String, toNick: String?) {
    val ctx = reactApplicationContext
    LiviOngoingCallHelper.setOutgoingCall(ctx, "", toUserId, toNick ?: "")
    val intent = Intent(ctx, OutgoingCallActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, "")
      putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
      putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick ?: "")
    }
    ctx.startActivity(intent)
  }

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

  /** Передать callId уже открытому экрану исходящего (после ответа сервера). */
  @ReactMethod
  fun notifyOutgoingCallId(callId: String) {
    val intent = Intent(OutgoingCallActivity.ACTION_OUTGOING_CALL_ID_READY).apply {
      setPackage(reactApplicationContext.packageName)
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
    }
    reactApplicationContext.sendBroadcast(intent)
  }

  @ReactMethod
  fun closeOutgoingCallActivity() {
    LiviOngoingCallHelper.clearOngoingCall(reactApplicationContext)
    val intent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
      setPackage(reactApplicationContext.packageName)
    }
    reactApplicationContext.sendBroadcast(intent)
  }

  /** Прочитать и сбросить флаг «пользователь нажал X на нативном экране исходящего». Вызывать из JS при переходе в active. */
  @ReactMethod
  fun getAndClearOutgoingCanceledByUserFlag(promise: Promise) {
    promise.resolve(LiviAppModule.getAndClearOutgoingCanceledByUserFlag())
  }

  /** FCM call_accepted: прочитать и сбросить callId; JS отправит call:getAccepted и получит call:accepted → переход на VideoCall. */
  @ReactMethod
  fun getAndClearPendingCallAcceptedCallId(promise: Promise) {
    promise.resolve(LiviAppModule.getAndClearPendingCallAcceptedCallId())
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

  /** Пометить callId как завершённый (отмена/таймаут). IncomingCallActivity не покажет экран для этого callId. Вызывать из JS при получении push call_ended, т.к. FCM call_canceled может не дойти. */
  @ReactMethod
  fun addEndedCallId(callId: String) {
    if (callId.isBlank()) return
    EndedCallIds.add(reactApplicationContext, callId)
  }

  /** Уже завершён/отменён ли этот звонок? Чтобы не показывать входящий при запоздалом Expo-пуше «call». */
  @ReactMethod
  fun isEndedCallId(callId: String, promise: Promise) {
    if (callId.isBlank()) {
      promise.resolve(false)
      return
    }
    try {
      promise.resolve(EndedCallIds.isEnded(reactApplicationContext, callId.trim()))
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /** Инициатор отменил вызов — пуш пришёл через Expo. То же, что FCM call_canceled: EndedCallIds, снять уведомление, broadcast чтобы IncomingCallActivity закрылась. */
  @ReactMethod
  fun notifyCallCanceled(callId: String) {
    if (callId.isBlank()) return
    EndedCallIds.add(reactApplicationContext, callId)
    (reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
    val intent = Intent(LiviFirebaseMessagingService.ACTION_CALL_CANCELED).apply {
      setPackage(reactApplicationContext.packageName)
      putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
    }
    reactApplicationContext.sendBroadcast(intent)
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

  /** Проверить, разрешены ли уведомления для приложения (Android 4.4+). Если выключены — нативный экран входящего в фоне не покажется. */
  @ReactMethod
  fun areNotificationsEnabled(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      promise.resolve(nm.areNotificationsEnabled())
    } else {
      promise.resolve(true)
    }
  }

  /** Проверить, разрешены ли полноэкранные уведомления (Android 14+). На старых версиях возвращает true. */
  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    if (Build.VERSION.SDK_INT >= 34) {
      val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      promise.resolve(nm.canUseFullScreenIntent())
    } else {
      promise.resolve(true)
    }
  }

  /** Открыть настройки уведомлений приложения (Android 8+). Включите «Полноэкранные уведомления» или «Показ как всплывающее окно» для входящих звонков. */
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
    private const val HEADLESS_TASK_CALL_KEEP = "RNCallKeepBackgroundMessage"

    private var reactContextRef: ReactApplicationContext? = null

    /**
     * Пытается запустить headless-задачу CallKeep (ConnectionService) для входящего звонка.
     * Вызывается из FCM при type=call. Если задача запущена — системный UI звонка (как в Telegram).
     * Callback вызывается на main thread; true = headless запущен, не показывать своё уведомление/активность.
     */
    @JvmStatic
    fun tryStartCallKeepHeadlessTask(callId: String, from: String, fromNick: String, callback: (Boolean) -> Unit) {
      val ctx = reactContextRef
      if (ctx == null) {
        Handler(Looper.getMainLooper()).post { callback(false) }
        return
      }
      Handler(Looper.getMainLooper()).post {
        var started = false
        try {
          if (ctx.hasActiveReactInstance()) {
            val data = Arguments.createMap().apply {
              putString("type", "call")
              putString("callId", callId)
              putString("from", from)
              putString("fromNick", fromNick)
            }
            val config = HeadlessJsTaskConfig(HEADLESS_TASK_CALL_KEEP, data, 10_000L, false)
            HeadlessJsTaskContext.getInstance(ctx).startTask(config)
            started = true
            Log.d(NAME, "headless task started for callId=$callId")
          }
        } catch (e: Exception) {
          Log.w(NAME, "headless task start failed", e)
        }
        callback(started)
      }
    }

    /** Флаг: пользователь нажал X на нативном экране исходящего. Читается из JS при переходе в active (на случай потери события). */
    @Volatile
    var outgoingCanceledByUserFlag: Boolean = false
      private set

    /** Вызвать из OutgoingCallActivity при нажатии X — React очистит состояние исходящего. */
    @JvmStatic
    fun emitOutgoingCallCanceledByUser() {
      outgoingCanceledByUserFlag = true
      reactContextRef?.runOnUiQueueThread {
        reactContextRef?.emitDeviceEvent("OutgoingCallCanceledByUser", null)
      }
    }

    @JvmStatic
    fun getAndClearOutgoingCanceledByUserFlag(): Boolean {
      return outgoingCanceledByUserFlag.also { outgoingCanceledByUserFlag = false }
    }

    /** FCM call_accepted: сохранить callId до старта MainActivity; React вызовет getAndClearPendingCallAcceptedCallId и отправит call:getAccepted. */
    @Volatile
    var pendingCallAcceptedCallId: String? = null
      private set

    @JvmStatic
    fun setPendingCallAcceptedCallId(callId: String?) {
      pendingCallAcceptedCallId = callId
    }

    @JvmStatic
    fun getAndClearPendingCallAcceptedCallId(): String? {
      return pendingCallAcceptedCallId.also { pendingCallAcceptedCallId = null }
    }

    /** Вызвать из IncomingCallActivity при нажатии X — React очистит состояние входящего. */
    @JvmStatic
    fun emitIncomingCallDeclinedByUser(callId: String) {
      reactContextRef?.runOnUiQueueThread {
        val params = Arguments.createMap()
        params.putString("callId", callId)
        reactContextRef?.emitDeviceEvent("IncomingCallDeclinedByUser", params)
      }
    }
  }
}
