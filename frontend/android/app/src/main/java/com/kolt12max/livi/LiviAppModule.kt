package com.kolt12max.livi

import android.app.NotificationManager
import android.content.Context
import android.service.notification.StatusBarNotification
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.VibrationAttributes
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
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

  /** Показать нативный экран исходящего сразу (без callId). callId придёт позже через notifyOutgoingCallId. Сохраняем toUserId/toNick, чтобы запустить звук из notifyOutgoingCallId даже если broadcast не успел дойти до Activity. */
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

  /** Передать callId уже открытому экрану исходящего (после ответа сервера). Запускаем сервис (звук, таймаут) сразу отсюда, чтобы рингтон не зависел от того, успела ли Activity принять broadcast. */
  @ReactMethod
  fun notifyOutgoingCallId(callId: String) {
    val ctx = reactApplicationContext
    val intent = Intent(OutgoingCallActivity.ACTION_OUTGOING_CALL_ID_READY).apply {
      setPackage(ctx.packageName)
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
    }
    ctx.sendBroadcast(intent)
    val (toUserId, toNick) = LiviOngoingCallHelper.getOutgoingToUserAndNick(ctx) ?: return
    LiviOutgoingCallService.start(ctx, callId, toUserId, toNick)
  }

  @ReactMethod
  fun closeOutgoingCallActivity() {
    LiviOngoingCallHelper.clearOngoingCall(reactApplicationContext)
    val intent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
      setPackage(reactApplicationContext.packageName)
    }
    reactApplicationContext.sendBroadcast(intent)
  }

  /**
   * Вывести MainActivity на передний план (сценарий «только сокет»: call:accepted пришёл по сокету,
   * FCM call_accepted не сработал — закрываем исходящий и показываем экран видеозвонка).
   * Дублируем логику FCM: broadcast + принудительное закрытие OutgoingCallActivity через startActivity(EXTRA_CLOSE_IMMEDIATELY), затем MainActivity.
   * Вызывать из JS после навигации на VideoCall и closeOutgoingCallActivity().
   */
  @ReactMethod
  fun bringMainActivityToFront() {
    val ctx = reactApplicationContext
    LiviOngoingCallHelper.clearOngoingCall(ctx)
    // 1) Broadcast — закрыть OutgoingCallActivity, если на экране
    val closeOutgoing = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
      setPackage(ctx.packageName)
    }
    ctx.sendBroadcast(closeOutgoing)
    LiviOutgoingCallService.stop(ctx)
    // 2) Принудительно закрыть OutgoingCallActivity (как FCM): если broadcast не дошёл, активность получит intent и finish()
    val closeActivityIntent = Intent(ctx, OutgoingCallActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
    }
    try {
      ctx.startActivity(closeActivityIntent)
      Log.d(NAME, "bringMainActivityToFront: sent close intent to OutgoingCallActivity")
    } catch (e: Exception) {
      Log.w(NAME, "bringMainActivityToFront: startActivity OutgoingCall(close) failed", e)
    }
    // 3) Вывести MainActivity на передний план после задержки, чтобы OutgoingCallActivity успела обработать onNewIntent и finish() (Samsung A35 и др.)
    val mainIntent = Intent(ctx, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    Handler(Looper.getMainLooper()).postDelayed({
      try {
        ctx.startActivity(mainIntent)
        Log.d(NAME, "bringMainActivityToFront: MainActivity brought to front")
      } catch (e: Exception) {
        Log.w(NAME, "bringMainActivityToFront: startActivity MainActivity failed", e)
      }
    }, 500)
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

  /** Вибрация звонка (Настройки → Вибрация звонка) для входящего, когда UI показывается внутри приложения. USAGE_RINGTONE на API 33+. */
  @ReactMethod
  fun startIncomingCallVibration() {
    val ctx = reactApplicationContext
    val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    } ?: return
    if (!vibrator.hasVibrator()) return
    try {
      val pattern = longArrayOf(0, 500, 200, 500)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val effect = VibrationEffect.createWaveform(pattern, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          val attrs = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_RINGTONE)
          vibrator.vibrate(effect, attrs)
        } else {
          vibrator.vibrate(effect)
        }
      } else {
        @Suppress("DEPRECATION")
        vibrator.vibrate(pattern, 0)
      }
    } catch (e: Exception) {
      Log.w(NAME, "startIncomingCallVibration failed", e)
    }
  }

  @ReactMethod
  fun stopIncomingCallVibration() {
    try {
      val ctx = reactApplicationContext
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      }
      vibrator?.cancel()
    } catch (e: Exception) {
      Log.w(NAME, "stopIncomingCallVibration failed", e)
    }
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

  /** Прочитать и очистить список userId пропущенных вызовов, показанных из нативного кода (FCM call_ended). JS при открытии приложения инкрементирует по ним счётчик и обновляет бейдж. */
  @ReactMethod
  fun getAndClearPendingMissedCalls(promise: Promise) {
    try {
      val list = getAndClearPendingMissedCalls(reactApplicationContext)
      val arr = Arguments.createArray()
      list.forEach { arr.pushString(it) }
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.resolve(Arguments.createArray())
    }
  }

  /** Прочитать и сбросить флаг «открыть вкладку Друзья» (тап по уведомлению о пропущенном вызове). Возвращает true, если нужно перейти на вкладку Друзья. */
  @ReactMethod
  fun getAndClearPendingOpenTabFriends(promise: Promise) {
    try {
      val value = getAndClearPendingOpenTabFriends(reactApplicationContext)
      promise.resolve(value)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /** Снять уведомление «Пропущенный вызов» для userId и обнулить счётчик (при принятии вызова или открытии чата с этим пользователем). */
  @ReactMethod
  fun cancelMissedCallNotificationForUser(userId: String) {
    if (userId.isBlank()) return
    try {
      clearMissedCountForUser(reactApplicationContext, userId)
      val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.cancel(getMissedNotificationIdForUser(userId))
    } catch (_: Exception) {}
  }

  /** Синхронизировать счётчик пропущенных из JS и обновить текст уведомления в шторке (чтобы показывало то же число, что в приложении). */
  @ReactMethod
  fun syncMissedCountForUser(userId: String, count: Int) {
    if (userId.isBlank()) return
    try {
      setMissedCountForUser(reactApplicationContext, userId, count.coerceAtLeast(0))
      LiviFirebaseMessagingService.updateMissedCallNotification(reactApplicationContext, userId, count.coerceAtLeast(0))
    } catch (_: Exception) {}
  }

  /** Только снять уведомление «пропущенный вызов» в шторке для userId (счётчик не трогаем — пользователь «увидел» во вкладке Друзья). Вызываем cancel на main thread. */
  @ReactMethod
  fun dismissMissedCallNotificationOnly(userId: String) {
    if (userId.isBlank()) return
    val uid = userId.trim()
    Handler(Looper.getMainLooper()).post {
      try {
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(getMissedNotificationIdForUser(uid))
      } catch (_: Exception) {}
    }
  }

  /** Снять все уведомления «пропущенный вызов» в шторке по списку userId из нативного хранилища (тот же источник, что и при показе). */
  @ReactMethod
  fun dismissAllMissedCallNotifications() {
    Handler(Looper.getMainLooper()).post {
      try {
        val prefs = reactApplicationContext.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
        val map = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val it = map.keys()
        while (it.hasNext()) {
          val key = it.next().toString().trim()
          if (key.isNotEmpty()) nm.cancel(getMissedNotificationIdForUser(key))
        }
      } catch (_: Exception) {}
    }
  }

  /** Только выставить счётчик в нативе (без обновления уведомления). Вызывать при старте приложения, если бейдж уже «увиден». */
  @ReactMethod
  fun setMissedCountForUserOnly(userId: String, count: Int) {
    if (userId.isBlank()) return
    try {
      setMissedCountForUser(reactApplicationContext, userId, count.coerceAtLeast(0))
    } catch (_: Exception) {}
  }

  companion object {
    const val NAME = "LiviAppModule"
    const val PREFS_NAME = "LiviDeclinePrefs"
    const val PREFS_CALL = "LiviCallPrefs"
    private const val PREFS_PENDING_MISSED = "LiviPendingMissed"
    private const val KEY_PENDING_MISSED_IDS = "user_ids"
    private const val PREFS_MISSED_COUNT = "LiviMissedCount"
    private const val KEY_MISSED_COUNT_BY_USER = "by_user"
    /** callIds, для которых уже показали «пропущенный вызов» (дедуп FCM+Expo). Формат: "callId1:ts,callId2:ts". */
    private const val PREFS_MISSED_SHOWN_IDS = "LiviMissedShownIds"
    private const val KEY_MISSED_SHOWN_IDS = "ids"
    private const val MISSED_SHOWN_EXPIRY_MS = 120_000L
    private const val KEY_MISSED_NICK_PREFIX = "missed_nick_"
    const val MISSED_NOTIFICATION_ID_BASE = 1002
    const val ACTION_MISSED_CALL_DISMISSED = "com.kolt12max.livi.MISSED_CALL_DISMISSED"
    const val EXTRA_USER_ID = "user_id"
    const val KEY_INSTALL_ID = "install_id"
    const val KEY_SERVER_URL = "server_url"
    const val KEY_OUTGOING_CALL_TIMEOUT_MS = "outgoing_call_timeout_ms"
    private const val PREFS_OPEN_TAB = "LiviOpenTab"
    private const val KEY_PENDING_OPEN_TAB_FRIENDS = "pending_open_tab_friends"
    private const val HEADLESS_TASK_CALL_KEEP = "RNCallKeepBackgroundMessage"

    private var reactContextRef: ReactApplicationContext? = null

    /** Вызвать из MainActivity при intent с EXTRA_OPEN_TAB_FRIENDS (тап по уведомлению «Пропущенный вызов»). */
    @JvmStatic
    fun setPendingOpenTabFriends(context: Context) {
      context.getSharedPreferences(PREFS_OPEN_TAB, Context.MODE_PRIVATE).edit().putBoolean(KEY_PENDING_OPEN_TAB_FRIENDS, true).apply()
    }

    /** Снять все уведомления «пропущенный вызов» из шторки. Вызывать из MainActivity при тапе по уведомлению (без ожидания JS). */
    @JvmStatic
    fun dismissAllMissedCallNotificationsFromContext(context: Context) {
      try {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 1) По списку userId из prefs (источник истины при показе)
        val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
        val map = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
        val it = map.keys()
        while (it.hasNext()) {
          val key = it.next().toString().trim()
          if (key.isNotEmpty()) nm.cancel(getMissedNotificationIdForUser(key))
        }
        // 2) На API 23+: снять все активные уведомления с ID из диапазона «пропущенный вызов» (на случай рассинхрона prefs)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          try {
            @Suppress("DEPRECATION")
            val active = nm.getActiveNotifications()
            if (active != null) for (n in active) {
              val id = n.id
              if (id >= MISSED_NOTIFICATION_ID_BASE && id < MISSED_NOTIFICATION_ID_BASE + 0x8000) nm.cancel(id)
            }
          } catch (_: Exception) {}
        }
      } catch (_: Exception) {}
    }

    @JvmStatic
    fun getAndClearPendingOpenTabFriends(context: Context): Boolean {
      val prefs = context.getSharedPreferences(PREFS_OPEN_TAB, Context.MODE_PRIVATE)
      val value = prefs.getBoolean(KEY_PENDING_OPEN_TAB_FRIENDS, false)
      prefs.edit().remove(KEY_PENDING_OPEN_TAB_FRIENDS).apply()
      return value
    }

    /** Вызвать из LiviFirebaseMessagingService при показе «Пропущенный вызов» — чтобы при открытии приложения JS обновил счётчик и бейдж. */
    @JvmStatic
    fun addPendingMissedCall(context: Context, userId: String) {
      if (userId.isBlank()) return
      val prefs = context.getSharedPreferences(PREFS_PENDING_MISSED, Context.MODE_PRIVATE)
      val current = prefs.getString(KEY_PENDING_MISSED_IDS, "") ?: ""
      val list = if (current.isEmpty()) mutableListOf<String>() else current.split(',').toMutableList()
      list.add(userId.trim())
      prefs.edit().putString(KEY_PENDING_MISSED_IDS, list.joinToString(",")).apply()
    }

    @JvmStatic
    fun getAndClearPendingMissedCalls(context: Context): List<String> {
      val prefs = context.getSharedPreferences(PREFS_PENDING_MISSED, Context.MODE_PRIVATE)
      val current = prefs.getString(KEY_PENDING_MISSED_IDS, "") ?: ""
      prefs.edit().remove(KEY_PENDING_MISSED_IDS).apply()
      return if (current.isEmpty()) emptyList() else current.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }

    /** Счётчик пропущенных по userId для одного уведомления на пользователя. Увеличить и вернуть новый счёт. */
    @JvmStatic
    fun incrementMissedCountForUser(context: Context, userId: String): Int {
      if (userId.isBlank()) return 1
      val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
      val map = try {
        JSONObject(raw)
      } catch (_: Exception) {
        JSONObject()
      }
      val key = userId.trim()
      val count = map.optInt(key, 0) + 1
      map.put(key, count)
      prefs.edit().putString(KEY_MISSED_COUNT_BY_USER, map.toString()).apply()
      return count
    }

    /** Уже показывали «пропущенный вызов» для этого callId? (дедуп при двойной доставке FCM+Expo) */
    @JvmStatic
    fun wasMissedShownForCallId(context: Context, callId: String): Boolean {
      if (callId.isBlank()) return false
      val prefs = context.getSharedPreferences(PREFS_MISSED_SHOWN_IDS, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_MISSED_SHOWN_IDS, "") ?: ""
      val now = System.currentTimeMillis()
      val entries = raw.split(',').mapNotNull { entry ->
        val part = entry.trim()
        if (part.isEmpty()) return@mapNotNull null
        val idx = part.lastIndexOf(':')
        if (idx <= 0) return@mapNotNull null
        val id = part.substring(0, idx)
        val ts = part.substring(idx + 1).toLongOrNull() ?: 0L
        if (now - ts > MISSED_SHOWN_EXPIRY_MS) null else id to ts
      }
      return entries.any { it.first == callId.trim() }
    }

    /** Отметить, что для callId уже показали «пропущенный вызов». */
    @JvmStatic
    fun markMissedShownForCallId(context: Context, callId: String) {
      if (callId.isBlank()) return
      val prefs = context.getSharedPreferences(PREFS_MISSED_SHOWN_IDS, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_MISSED_SHOWN_IDS, "") ?: ""
      val now = System.currentTimeMillis()
      val entries = raw.split(',').mapNotNull { entry ->
        val part = entry.trim()
        if (part.isEmpty()) return@mapNotNull null
        val idx = part.lastIndexOf(':')
        if (idx <= 0) return@mapNotNull null
        val id = part.substring(0, idx)
        val ts = part.substring(idx + 1).toLongOrNull() ?: 0L
        if (now - ts > MISSED_SHOWN_EXPIRY_MS) null else "$id:$ts"
      }.toMutableList()
      entries.add("${callId.trim()}:$now")
      prefs.edit().putString(KEY_MISSED_SHOWN_IDS, entries.takeLast(50).joinToString(",")).apply()
    }

    /** Сохранить nick для обновления текста уведомления «пропущенный вызов». */
    @JvmStatic
    fun saveMissedCallNick(context: Context, userId: String, nick: String) {
      if (userId.isBlank()) return
      context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
        .edit().putString(KEY_MISSED_NICK_PREFIX + userId.trim(), nick).apply()
    }

    @JvmStatic
    fun getMissedCallNick(context: Context, userId: String): String {
      if (userId.isBlank()) return ""
      return context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
        .getString(KEY_MISSED_NICK_PREFIX + userId.trim(), "") ?: ""
    }

    /** Выставить счётчик пропущенных для userId (синхронизация из JS). */
    @JvmStatic
    fun setMissedCountForUser(context: Context, userId: String, count: Int) {
      if (userId.isBlank()) return
      val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
      val map = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
      map.put(userId.trim(), count.coerceAtLeast(0))
      prefs.edit().putString(KEY_MISSED_COUNT_BY_USER, map.toString()).apply()
    }

    /** Обнулить счёт пропущенных для userId (при смахивании уведомления или принятии вызова). */
    @JvmStatic
    fun clearMissedCountForUser(context: Context, userId: String) {
      if (userId.isBlank()) return
      val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
      val map = try {
        JSONObject(raw)
      } catch (_: Exception) {
        JSONObject()
      }
      map.remove(userId.trim())
      prefs.edit().putString(KEY_MISSED_COUNT_BY_USER, map.toString()).apply()
    }

    /** Стабильный ID уведомления «Пропущенный вызов» для userId — одно уведомление на пользователя. */
    @JvmStatic
    fun getMissedNotificationIdForUser(userId: String): Int {
      if (userId.isBlank()) return MISSED_NOTIFICATION_ID_BASE
      return MISSED_NOTIFICATION_ID_BASE + (userId.hashCode() and 0x7FFF)
    }

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

    /** Вызвать из MainActivity.onResume при intent с EXTRA_PENDING_CALL_ACCEPTED_CALL_ID — React запросит call:accepted и перейдёт на VideoCall. */
    @JvmStatic
    fun emitPendingCallAcceptedEvent() {
      reactContextRef?.runOnUiQueueThread {
        reactContextRef?.emitDeviceEvent("LiviPendingCallAccepted", null)
      }
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
