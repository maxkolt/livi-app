package com.kolt12max.livi

import android.app.NotificationManager
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Context
import android.util.Rational
import android.service.notification.StatusBarNotification
import android.content.Intent
import android.app.KeyguardManager
import android.graphics.Rect
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.VibrationAttributes
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import expo.modules.notifications.badge.BadgeHelper
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

  private fun buildSystemPiPSourceRect(activity: android.app.Activity): Rect? {
    return try {
      val root = activity.window?.decorView ?: return null
      val w = root.width
      val h = root.height
      if (w <= 0 || h <= 0) return null
      val ratioW = 9f
      val ratioH = 16f
      val targetW: Int
      val targetH: Int
      if (w.toFloat() / h.toFloat() > ratioW / ratioH) {
        targetH = h
        targetW = (h * (ratioW / ratioH)).toInt()
      } else {
        targetW = w
        targetH = (w * (ratioH / ratioW)).toInt()
      }
      val left = (w - targetW) / 2
      val top = (h - targetH) / 2
      Rect(left, top, left + targetW, top + targetH)
    } catch (_: Exception) {
      null
    }
  }

  /** Размеры decorView для синхронизации PiP overlay с нативным sourceRect (избегаем чёрных полос в системном PiP). */
  @ReactMethod
  fun getDecorViewSize(promise: Promise) {
    try {
      val activity = currentActivity ?: run {
        promise.reject("NO_ACTIVITY", "No current activity")
        return
      }
      activity.runOnUiThread {
        try {
          val root = activity.window?.decorView ?: run {
            promise.reject("NO_DECOR", "No decor view")
            return@runOnUiThread
          }
          val w = root.width
          val h = root.height
          Log.d(NAME, "getDecorViewSize: decorView w=$w h=$h")
          if (w <= 0 || h <= 0) {
            promise.reject("INVALID_SIZE", "Decor size is $w x $h")
            return@runOnUiThread
          }
          val map = Arguments.createMap()
          map.putInt("width", w)
          map.putInt("height", h)
          promise.resolve(map)
        } catch (e: Exception) {
          promise.reject("GET_DECOR_SIZE", e.message ?: "getDecorViewSize failed")
        }
      }
    } catch (e: Exception) {
      promise.reject("GET_DECOR_SIZE", e.message ?: "getDecorViewSize failed")
    }
  }

  /** Задержка (мс) перед запуском OutgoingCallActivity после broadcast закрытия: даём предыдущему экземпляру (singleInstance) успеть finish(); после завершения звонка UI успевает стабилизироваться. */
  private val OUTGOING_LAUNCH_DELAY_MS = 250L

  /** Показать нативный экран исходящего сразу (без callId). callId придёт позже через notifyOutgoingCallId. Сохраняем toUserId/toNick, чтобы запустить звук из notifyOutgoingCallId даже если broadcast не успел дойти до Activity. Перед запуском шлём broadcast закрытия предыдущего экрана, чтобы при повторном звонке (пока друг на неактивном экране) не поднимался старый singleInstance. */
  @ReactMethod
  fun launchOutgoingCallActivityWithoutCallId(toUserId: String, toNick: String?) {
    Log.d(NAME, "launchOutgoingCallActivityWithoutCallId: toUserId=$toUserId toNick=${toNick?.take(20)} hasCurrentActivity=${currentActivity != null}")
    val ctx = reactApplicationContext
    LiviOngoingCallHelper.setOutgoingCall(ctx, "", toUserId, toNick ?: "")
    val intent = Intent(ctx, OutgoingCallActivity::class.java).apply {
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, "")
      putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
      putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick ?: "")
    }
    closeAnyOutgoingScreenThenLaunch(ctx, intent, retryIfNoActivity = true)
  }

  /** Закрыть любой видимый экран исходящего (broadcast), затем через OUTGOING_LAUNCH_DELAY_MS запустить новый — чтобы при повторном звонке не поднимался старый singleInstance. */
  private fun closeAnyOutgoingScreenThenLaunch(ctx: Context, intent: Intent, retryIfNoActivity: Boolean) {
    val closeIntent = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply { setPackage(ctx.packageName) }
    ctx.sendBroadcast(closeIntent)
    Log.d(NAME, "launchOutgoing: sent close broadcast, posting launch in ${OUTGOING_LAUNCH_DELAY_MS}ms")
    Handler(Looper.getMainLooper()).postDelayed({
      runOnUiThreadLaunchOutgoing(intent, ctx, retryIfNoActivity)
    }, OUTGOING_LAUNCH_DELAY_MS)
  }

  /** Флаги для запуска OutgoingCallActivity из currentActivity: NEW_TASK + CLEAR_TASK чтобы при повторном вызове не подхватить старый close intent (FCM/bringMainActivityToFront) — задача очищается и создаётся с нашим intent. */
  private val OUTGOING_FLAGS_FROM_ACTIVITY = (Intent.FLAG_ACTIVITY_NEW_TASK
      or Intent.FLAG_ACTIVITY_CLEAR_TASK
      or Intent.FLAG_ACTIVITY_SINGLE_TOP
      or Intent.FLAG_ACTIVITY_CLEAR_TOP
      or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)

  /** Запуск OutgoingCallActivity на UI-потоке (currentActivity надёжнее на main thread). При retryIfNoActivity=true при null делаем одну повторную попытку через 150ms. */
  private fun runOnUiThreadLaunchOutgoing(intent: Intent, ctx: Context, retryIfNoActivity: Boolean) {
    Handler(Looper.getMainLooper()).post {
      try {
        val act = currentActivity
        if (act != null) {
          intent.addFlags(OUTGOING_FLAGS_FROM_ACTIVITY)
          act.startActivity(intent)
          Log.d(NAME, "launchOutgoingCall: startActivity from currentActivity (UI thread, NEW_TASK)")
        } else {
          if (retryIfNoActivity) {
            Handler(Looper.getMainLooper()).postDelayed({
              try {
                val act2 = currentActivity
                if (act2 != null) {
                  intent.addFlags(OUTGOING_FLAGS_FROM_ACTIVITY)
                  act2.startActivity(intent)
                  Log.d(NAME, "launchOutgoingCall: startActivity from currentActivity (retry 150ms, NEW_TASK)")
                } else {
                  intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                  ctx.startActivity(intent)
                  Log.d(NAME, "launchOutgoingCall: startActivity from app context after retry (no currentActivity)")
                }
              } catch (e: Exception) {
                Log.e(NAME, "launchOutgoingCall: retry startActivity failed", e)
              }
            }, 150)
          } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            ctx.startActivity(intent)
            Log.d(NAME, "launchOutgoingCall: startActivity from app context (no currentActivity)")
          }
        }
      } catch (e: Exception) {
        Log.e(NAME, "launchOutgoingCall: startActivity failed", e)
      }
    }
  }

  @ReactMethod
  fun launchOutgoingCallActivity(callId: String, toUserId: String, toNick: String?) {
    Log.d(NAME, "launchOutgoingCallActivity: callId=${callId.take(24)} toUserId=$toUserId hasCurrentActivity=${currentActivity != null}")
    val ctx = reactApplicationContext
    LiviOngoingCallHelper.setOutgoingCall(ctx, callId, toUserId, toNick ?: "")
    val intent = Intent(ctx, OutgoingCallActivity::class.java).apply {
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
      putExtra(OutgoingCallActivity.EXTRA_TO_USER_ID, toUserId)
      putExtra(OutgoingCallActivity.EXTRA_TO_NICK, toNick ?: "")
    }
    closeAnyOutgoingScreenThenLaunch(ctx, intent, retryIfNoActivity = true)
  }

  /** Передать callId уже открытому экрану исходящего (после ответа сервера). Запускаем сервис (звук, таймаут) сразу отсюда, чтобы рингтон не зависел от того, успела ли Activity принять broadcast. */
  @ReactMethod
  fun notifyOutgoingCallId(callId: String) {
    Log.d(NAME, "notifyOutgoingCallId: callId=${callId.take(24)} sending broadcast and starting service")
    val ctx = reactApplicationContext
    val intent = Intent(OutgoingCallActivity.ACTION_OUTGOING_CALL_ID_READY).apply {
      setPackage(ctx.packageName)
      putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
    }
    ctx.sendBroadcast(intent)
    val (toUserId, toNick) = LiviOngoingCallHelper.getOutgoingToUserAndNick(ctx) ?: run {
      Log.w(NAME, "notifyOutgoingCallId: no outgoing toUserId/toNick in helper — service not started")
      return
    }
    LiviOutgoingCallService.start(ctx, callId, toUserId, toNick)
    Log.d(NAME, "notifyOutgoingCallId: LiviOutgoingCallService.start done")
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
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NO_HISTORY)
      putExtra(OutgoingCallActivity.EXTRA_CLOSE_IMMEDIATELY, true)
    }
    try {
      ctx.startActivity(closeActivityIntent)
      Log.d(NAME, "bringMainActivityToFront: sent close intent to OutgoingCallActivity")
    } catch (e: Exception) {
      Log.w(NAME, "bringMainActivityToFront: startActivity OutgoingCall(close) failed", e)
    }
    // 3) Вывести задачу приложения на передний план после задержки (OutgoingCallActivity успеет finish()).
    // Нельзя использовать ActivityManager.moveTaskToFront — для обычных приложений нужен REORDER_TASKS (только системе).
    val mainIntent = Intent(ctx, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    Handler(Looper.getMainLooper()).postDelayed({
      try {
        ctx.startActivity(mainIntent)
        Log.d(NAME, "bringMainActivityToFront: MainActivity startActivity (reorder to front)")
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

  /** Счётчики пропущенных по userId из нативного хранилища (JSON). Для синхронизации с JS при фокусе — один источник истины. */
  @ReactMethod
  fun getMissedCountByUserJson(promise: Promise) {
    try {
      promise.resolve(LiviAppModule.getMissedCountByUserJson(reactApplicationContext))
    } catch (e: Exception) {
      promise.resolve("{}")
    }
  }

  /** Единый UI входящего: открыть нативный IncomingCallActivity (foreground и из deep link livi://incoming-call). */
  @ReactMethod
  fun launchIncomingCallActivity(callId: String, from: String, fromNick: String?) {
    val ctx = reactApplicationContext
    // Не cancel уведомление до broadcast: иначе срываем foreground FGS до detach. Не stopService(FGS): onDestroy
    // вызывал полный stop и глушил IncomingCallActivity (один вибросигнал, без мелодии).
    try {
      val shown = Intent(IncomingCallForegroundService.ACTION_INCOMING_CALL_ACTIVITY_SHOWN).apply {
        setPackage(ctx.packageName)
        putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
      }
      ctx.sendBroadcast(shown)
      Handler(Looper.getMainLooper()).postDelayed({
        try { ctx.sendBroadcast(shown) } catch (_: Exception) {}
      }, 250)
    } catch (_: Exception) {}

    LiviOngoingCallHelper.setIncomingCall(ctx, callId, from, fromNick ?: "")
    // Те же флаги, что и в FCM (buildIncomingCallActivityIntent): иначе при активном процессе + заблокированном экране
    // startActivity без SHOW_WHEN_LOCKED / TURN_SCREEN_ON часто не показывает входящий поверх блокировки.
    val intent = LiviFirebaseMessagingService.buildIncomingCallActivityIntent(ctx, callId, from, fromNick ?: "")
    ctx.startActivity(intent)
  }

  /**
   * Показ системного UI входящего через IncomingCallForegroundService (уведомление в шторке, без heads-up поверх экрана).
   * Используется для socket-path, когда приложение не в фокусе (AppState != active).
   */
  @ReactMethod
  fun showIncomingCallSystemUI(callId: String, from: String, fromNick: String?) {
    if (callId.isBlank() || from.isBlank()) return
    val ctx = reactApplicationContext
    try {
      LiviOngoingCallHelper.setIncomingCall(ctx, callId, from, fromNick ?: "")
    } catch (_: Exception) {}

    // Как в LiviFirebaseMessagingService: сначала пробуем Activity сразу (сокет в фоне / экран выключен — иначе только FGS с «тихим»
    // уведомлением без fullScreenIntent часто не пробивает BAL на блокировке).
    try {
      val launchIntent = LiviFirebaseMessagingService.buildIncomingCallActivityIntent(ctx, callId, from, fromNick ?: "")
      ctx.startActivity(launchIntent)
      Log.d(NAME, "showIncomingCallSystemUI: immediate startActivity OK")
    } catch (e: Exception) {
      Log.w(NAME, "showIncomingCallSystemUI: immediate startActivity failed, relying on FGS", e)
    }

    try {
      LiviFirebaseMessagingService.ensureCallChannel(ctx)
      val keyguardLocked = try {
        (ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked == true
      } catch (_: Exception) {
        false
      }
      // Разблокирован: тихое уведомление в шторке (как FCM). Заблокирован: уведомление с fullScreenIntent — запасной путь к экрану.
      val serviceIntent = Intent(ctx, IncomingCallForegroundService::class.java).apply {
        putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
        putExtra(IncomingCallForegroundService.EXTRA_FROM, from)
        putExtra(IncomingCallForegroundService.EXTRA_FROM_NICK, fromNick ?: "")
        putExtra(IncomingCallForegroundService.EXTRA_HEADS_UP_ONLY, false)
        putExtra(IncomingCallForegroundService.EXTRA_SILENT_NOTIFICATION, !keyguardLocked)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(serviceIntent) else ctx.startService(serviceIntent)
      Log.d(NAME, "showIncomingCallSystemUI: started IncomingCallForegroundService (silentShade=${!keyguardLocked})")
    } catch (e: Exception) {
      Log.w(NAME, "showIncomingCallSystemUI: failed to start IncomingCallForegroundService", e)
      try {
        ctx.startActivity(LiviFirebaseMessagingService.buildIncomingCallActivityIntent(ctx, callId, from, fromNick ?: ""))
      } catch (_: Exception) {}
    }
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

  /** Прочитать и сбросить входящий звонок, переданный из FCM для показа через CallKeep (ConnectionService). JS вызовет displayIncomingCall и stopIncomingCallForegroundService. */
  @ReactMethod
  fun getAndClearPendingIncomingCallForCallKeep(promise: Promise) {
    try {
      val data = getAndClearPendingIncomingCallForCallKeep()
      if (data == null) {
        promise.resolve(null)
        return
      }
      val map = Arguments.createMap().apply {
        putString("callId", data.first)
        putString("from", data.second)
        putString("fromNick", data.third)
      }
      promise.resolve(map)
    } catch (e: Exception) {
      promise.resolve(null)
    }
  }

  /** Остановить IncomingCallForegroundService и снять уведомление входящего вызова. */
  @ReactMethod
  fun stopIncomingCallForegroundService() {
    try {
      val app = reactApplicationContext.applicationContext
      app.stopService(Intent(app, IncomingCallForegroundService::class.java))
      (app.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
        ?.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
    } catch (_: Exception) {}
  }

  /** Запустить foreground-сервис во время активного видеозвонка — сокет не засыпает в фоне/PiP. partnerNick — никнейм для уведомления «Видеозвонок от {nick}» или пусто для «от кого-то». */
  @ReactMethod
  fun startActiveCallForegroundService(partnerNick: String?) {
    try {
      ActiveCallForegroundService.start(reactApplicationContext, partnerNick?.takeIf { it.isNotBlank() })
    } catch (e: Exception) {
      android.util.Log.w(NAME, "startActiveCallForegroundService failed", e)
    }
  }

  /** Остановить foreground-сервис активного видеозвонка. Вызывается из JS при setActiveVideoCall(false). */
  @ReactMethod
  fun stopActiveCallForegroundService() {
    try {
      ActiveCallForegroundService.stop(reactApplicationContext)
    } catch (e: Exception) {
      android.util.Log.w(NAME, "stopActiveCallForegroundService failed", e)
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

  /** Мелодия звонка (Настройки → Мелодия звонка) + вибрация звонка для ConnectionService/CallKeep. */
  @ReactMethod
  fun startIncomingCallRingtoneAndVibration() {
    startIncomingCallRingtoneAndVibrationStatic(reactApplicationContext)
  }

  @ReactMethod
  fun stopIncomingCallRingtoneAndVibration() {
    try {
      stopIncomingCallRingtoneAndVibrationStatic(reactApplicationContext)
    } catch (e: Exception) {
      Log.w(NAME, "stopIncomingCallRingtoneAndVibration failed", e)
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

  /** Уход в фон по Back + вход в системный PiP с натива (таймер не зависит от JS, PiP показывается сразу). */
  @ReactMethod
  fun moveTaskToBackAndEnterPiP(nonRoot: Boolean) {
    val activity = currentActivity ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    activity.runOnUiThread {
      activity.moveTaskToBack(nonRoot)
      val handler = Handler(Looper.getMainLooper())
      val tryEnterPiP = Runnable {
        try {
          if (activity.isInPictureInPictureMode) return@Runnable
          val ratio = Rational(9, 16)
          val builder = PictureInPictureParams.Builder()
            .setAspectRatio(ratio)
            .setActions(emptyList<RemoteAction>())
          val sourceRect = buildSystemPiPSourceRect(activity)
          if (sourceRect != null) builder.setSourceRectHint(sourceRect)
          val params = builder.build()
          if (activity.enterPictureInPictureMode(params)) {
            Log.d(NAME, "moveTaskToBackAndEnterPiP: entered PiP")
          }
        } catch (e2: Exception) {
          Log.w(NAME, "moveTaskToBackAndEnterPiP attempt failed", e2)
        }
      }
      handler.postDelayed(tryEnterPiP, 150)
      handler.postDelayed(tryEnterPiP, 350)
      handler.postDelayed(tryEnterPiP, 550)
      handler.postDelayed(tryEnterPiP, 850)
      handler.postDelayed(tryEnterPiP, 1200)
    }
  }

  /** Включить/выключить системный PiP при нажатии Home: true = при уходе в фон перейти в Picture-in-Picture (окно поверх лаунчера). Вызывать из JS при активном видеозвонке или при показе in-app PiP. На Android 12+ дополнительно включается авто-вход в PiP для совместимости со всеми устройствами. */
  @ReactMethod
  fun setShouldEnterPiPOnLeaveHint(enabled: Boolean) {
    val prev = LiviAppModule.getShouldEnterPiPOnLeaveHint()
    LiviAppModule.setPiPOnLeaveHintEnabled(enabled)
    if (prev != enabled) {
      Log.i(NAME, "setShouldEnterPiPOnLeaveHint: $prev -> $enabled")
    }
    // ВАЖНО: сознательно НЕ включаем Activity#setAutoEnterPictureInPictureEnabled на Android 12+.
    // Причина: авто-вход в PiP может срабатывать в неожиданные моменты (особенно на Samsung/OneUI)
    // во время переходов/закрытия нативных экранов, что выглядит как "само выбросило из приложения".
    // Мы хотим вход в системный PiP только по явным действиям пользователя (выход из приложения),
    // поэтому полагаемся на onUserLeaveHint() в MainActivity и/или явный requestEnterPictureInPicture() в обработчиках Back на корне.
  }

  /** Флаг «идёт завершение звонка»: при true не входить в системный PiP в onUserLeaveHint (чтобы не выкидывать на главный экран при принятии с блокировки). */
  @ReactMethod
  fun setEndingCallInProgress(inProgress: Boolean) {
    LiviAppModule.setEndingCallInProgressStatic(inProgress)
  }

  /** Запросить переход в системный PiP из JS (при уходе по кнопке «Назад» с экрана звонка — показываем in-app PiP и затем системное PiP-окно). */
  @ReactMethod
  fun requestEnterPictureInPicture() {
    val activity = currentActivity ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    activity.runOnUiThread {
      try {
        // Как в onUserLeaveHint(Home): сначала сигнализируем JS подготовить fullscreen PiP UI,
        // затем пробуем несколько раз с короткими задержками, чтобы Android захватил уже
        // подготовленный кадр (без случайного зума при сценарии Back).
        val root = activity.window?.decorView
        val decorW = root?.width ?: 0
        val decorH = root?.height ?: 0
        emitAboutToEnterSystemPiP(decorW, decorH)
        val ratio = Rational(9, 16)
        val builder = PictureInPictureParams.Builder()
          .setAspectRatio(ratio)
          .setActions(emptyList<RemoteAction>())
        val sourceRect = buildSystemPiPSourceRect(activity)
        if (sourceRect != null) {
          builder.setSourceRectHint(sourceRect)
          Log.d(NAME, "requestEnterPictureInPicture sourceRect left=${sourceRect.left} top=${sourceRect.top} right=${sourceRect.right} bottom=${sourceRect.bottom} w=${sourceRect.width()} h=${sourceRect.height()}")
        } else {
          Log.w(NAME, "requestEnterPictureInPicture buildSystemPiPSourceRect returned null")
        }
        val params = builder.build()
        val handler = Handler(Looper.getMainLooper())
        val tryEnterPiP = Runnable {
          try {
            if (activity.isInPictureInPictureMode) return@Runnable
            if (activity.enterPictureInPictureMode(params)) {
              Log.d("LiviAppModule", "Entered Picture-in-Picture mode (requested from JS)")
            } else {
              Log.w("LiviAppModule", "requestEnterPictureInPicture: enterPictureInPictureMode returned false")
            }
          } catch (e2: Exception) {
            Log.w("LiviAppModule", "requestEnterPictureInPicture attempt failed", e2)
          }
        }
        // ВАЖНО: небольшая стартовая пауза всё ещё нужна, чтобы JS успел отрисовать overlay 9:16,
        // но прежние 450ms ощущались как "залипание" на первом Back. Делаем раннюю попытку
        // и оставляем более поздние ретраи как страховку для медленных устройств.
        handler.postDelayed(tryEnterPiP, 120)
        handler.postDelayed(tryEnterPiP, 260)
        handler.postDelayed(tryEnterPiP, 450)
        handler.postDelayed(tryEnterPiP, 700)
        handler.postDelayed(tryEnterPiP, 1000)
      } catch (e: Exception) {
        Log.w("LiviAppModule", "requestEnterPictureInPicture failed", e)
      }
    }
  }

  /** Выйти из системного PiP без открытия приложения: только закрыть окно PiP. Сначала уводим задачу в фон (moveTaskToBack), затем finish() — чтобы приложение не открывалось на экране приветствия. */
  @ReactMethod
  fun requestExitSystemPiP() {
    val activity = currentActivity ?: return
    val run: Runnable = Runnable {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity.isInPictureInPictureMode) {
          activity.moveTaskToBack(true)
          Handler(Looper.getMainLooper()).postDelayed({
            try {
              activity.finish()
              Log.d("LiviAppModule", "requestExitSystemPiP: moved to back, then finish() (was in PiP)")
            } catch (e2: Exception) {
              Log.w("LiviAppModule", "requestExitSystemPiP finish failed", e2)
            }
          }, 80)
        } else {
          Log.d("LiviAppModule", "requestExitSystemPiP: not in PiP, skipping finish()")
        }
      } catch (e: Exception) {
        Log.w("LiviAppModule", "requestExitSystemPiP failed", e)
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      run.run()
    } else {
      activity.runOnUiThread(run)
    }
  }

  /** Сохранить callId/roomId для завершения звонка из системного PiP (кнопка «Завершить» в окне PiP). Вызывать из JS при показе PiP. */
  @ReactMethod
  fun setPiPEndCallParams(callId: String, roomId: String) {
    LiviAppModule.setPiPEndCallParamsStatic(callId, roomId)
  }

  /** Вернуть сохранённые callId/roomId для обработки события EndCallFromPiP в JS. */
  @ReactMethod
  fun getPiPEndCallParams(promise: Promise) {
    LiviAppModule.getPiPEndCallParamsStatic(promise)
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
    val normalized = normalizeApiServerBase(url) ?: return
    reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_SERVER_URL, normalized)
      .apply()
  }

  /** Для POST /api/calls/decline: заголовок x-user-id (сервер сверяет с installId в БД). */
  @ReactMethod
  fun setUserIdForDecline(userId: String?) {
    val p = reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
    if (userId.isNullOrBlank()) {
      p.remove(KEY_USER_ID_FOR_DECLINE).apply()
    } else {
      p.putString(KEY_USER_ID_FOR_DECLINE, userId.trim()).apply()
    }
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

  /** Проверить, разрешено ли приложению «отображение поверх других окон» (Всегда сверху). Нужно для входящих на блокировке и PiP. */
  @ReactMethod
  fun canDrawOverlays(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      promise.resolve(Settings.canDrawOverlays(reactApplicationContext))
    } else {
      promise.resolve(true)
    }
  }

  /** Открыть экран настроек «Отображение поверх других окон» / «Всегда сверху» для приложения. Пользователь включает переключатель вручную. */
  @ReactMethod
  fun openOverlayPermissionSettings() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val ctx = reactApplicationContext
    val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
      data = android.net.Uri.parse("package:${ctx.packageName}")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
      ctx.startActivity(intent)
    } catch (_: Exception) {}
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

  /** Проверить, отключена ли оптимизация батареи для приложения (Doze whitelist). */
  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      promise.resolve(true)
      return
    }
    try {
      val pm = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
      promise.resolve(pm?.isIgnoringBatteryOptimizations(reactApplicationContext.packageName) == true)
    } catch (_: Exception) {
      promise.resolve(false)
    }
  }

  /** Открыть системный экран отключения battery optimization для приложения. */
  @ReactMethod
  fun openBatteryOptimizationSettings() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val ctx = reactApplicationContext
    val pkgUri = Uri.parse("package:${ctx.packageName}")
    val intents = listOf(
      Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = pkgUri
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = pkgUri
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
    )
    for (intent in intents) {
      try {
        if (intent.resolveActivity(ctx.packageManager) != null) {
          ctx.startActivity(intent)
          return
        }
      } catch (_: Exception) {}
    }
  }

  /** OEM fallback: открыть экран автозапуска/фоновой активности (Xiaomi/Oppo/Vivo/Huawei/Realme и др.). */
  @ReactMethod
  fun openAutostartSettings() {
    val ctx = reactApplicationContext
    val candidates = listOf(
      Intent().apply {
        component = android.content.ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent().apply {
        component = android.content.ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent().apply {
        component = android.content.ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent().apply {
        component = android.content.ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent().apply {
        component = android.content.ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent().apply {
        component = android.content.ComponentName("com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:${ctx.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
    )
    for (intent in candidates) {
      try {
        if (intent.resolveActivity(ctx.packageManager) != null) {
          ctx.startActivity(intent)
          return
        }
      } catch (_: Exception) {}
    }
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

  /** Удалить userId из списка pending пропущенных (дедуп: после инкремента по сокету call:timeout не считать повторно при getAndClearPendingMissedCalls). */
  @ReactMethod
  fun removePendingMissedCall(userId: String) {
    try {
      removePendingMissedCall(reactApplicationContext, userId)
    } catch (_: Exception) {}
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

  /** Выставить счётчик в нативе и обновить текст уведомления в шторке (чтобы число в шторке совпадало с приложением). Вызывать при старте/резюме, если бейдж уже «увиден». */
  @ReactMethod
  fun setMissedCountForUserOnly(userId: String, count: Int) {
    if (userId.isBlank()) return
    try {
      val c = count.coerceAtLeast(0)
      setMissedCountForUser(reactApplicationContext, userId, c)
      LiviFirebaseMessagingService.updateMissedCallNotification(reactApplicationContext, userId, c)
    } catch (_: Exception) {}
  }

  /** Обновить сводные уведомления в шторке: общие пропущенные звонки и общие непрочитанные сообщения (отдельно). Вызывается из JS при syncAppBadgeFromMissedCount когда бейдж не «увиден». */
  @ReactMethod
  fun updateSummaryNotifications(missedTotal: Int, unreadTotal: Int) {
    Handler(Looper.getMainLooper()).post {
      try {
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (missedTotal > 0) {
          val prefs = reactApplicationContext.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
          val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
          val map = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
          val it = map.keys()
          while (it.hasNext()) {
            val key = it.next().toString().trim()
            if (key.isNotEmpty()) nm.cancel(getMissedNotificationIdForUser(key))
          }
          LiviFirebaseMessagingService.updateSummaryMissedCallsNotification(reactApplicationContext, missedTotal)
        } else {
          nm.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_SUMMARY_MISSED_CALLS)
        }
        // Сводное уведомление «Непрочитанные сообщения» не показываем — в шторке только одно уведомление на сообщение (От кого HH:MM + превью) из FCM.
        if (unreadTotal <= 0) {
          nm.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_SUMMARY_UNREAD)
        }
      } catch (_: Exception) {}
    }
  }

  /** Больше не показываем сводное уведомление «Непрочитанные сообщения» — только одно уведомление на сообщение (От кого HH:MM + превью) из FCM. Метод оставлен для совместимости: при unreadTotal=0 снимаем сводное. */
  @ReactMethod
  fun updateSummaryUnreadWithLast(unreadTotal: Int, lastFromNick: String, timeStr: String) {
    Handler(Looper.getMainLooper()).post {
      try {
        if (unreadTotal <= 0) {
          val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
          nm.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_SUMMARY_UNREAD)
        }
      } catch (_: Exception) {}
    }
  }

  /** Снять сводные уведомления из шторки (при заходе во вкладку Друзья). */
  @ReactMethod
  fun dismissSummaryNotifications() {
    Handler(Looper.getMainLooper()).post {
      try {
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_SUMMARY_MISSED_CALLS)
        nm.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_SUMMARY_UNREAD)
      } catch (_: Exception) {}
    }
  }

  /** Снять уведомление о сообщениях от одного пользователя (при заходе в чат с ним). */
  @ReactMethod
  fun dismissMessageNotificationForUser(userId: String) {
    if (userId.isBlank()) return
    Handler(Looper.getMainLooper()).post {
      try {
        val id = LiviAppModule.getMessageNotificationIdForUser(userId)
        (reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(id)
      } catch (_: Exception) {}
    }
  }

  /** Снять все уведомления о сообщениях из шторки (при заходе во вкладку Друзья). */
  @ReactMethod
  fun dismissAllMessageNotifications() {
    Handler(Looper.getMainLooper()).post {
      try {
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_SUMMARY_UNREAD)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          try {
            @Suppress("DEPRECATION")
            val active = nm.getActiveNotifications()
            if (active != null) {
              val base = LiviFirebaseMessagingService.NOTIFICATION_ID_MESSAGE_BASE
              for (n in active) {
                val id = n.id
                if (id >= base && id < base + 0x8000) nm.cancel(id)
              }
            }
          } catch (_: Exception) {}
        }
      } catch (_: Exception) {}
    }
  }

  /** Очистить нативное хранилище пропущенных вызовов и выставить бейдж иконки в 0. Вызывать из JS при «просмотрено»/«прочитано», чтобы следующий FCM не прибавлял старые пропущенные к unreadCount. */
  @ReactMethod
  fun clearAllMissedCountsAndSetBadgeZero() {
    Handler(Looper.getMainLooper()).post {
      try {
        LiviAppModule.clearAllMissedCountsAndSetBadgeZeroStatic(reactApplicationContext)
      } catch (_: Exception) {}
    }
  }

  companion object {
    const val NAME = "LiviAppModule"
    /** Intent action: FCM входящий при разблокированном экране — показать через CallKeep (ConnectionService). MainActivity сохраняет extras в pending; JS вызовет displayIncomingCall. */
    const val ACTION_INCOMING_CALL_CALLKEEP = "com.kolt12max.livi.INCOMING_CALL_CALLKEEP"
    /** Остановить рингтон/вибрацию на IncomingCallActivity (отдельный MediaPlayer), чтобы не накладывался на CallKeep. */
    const val ACTION_STOP_INCOMING_ACTIVITY_RINGTONE = "com.kolt12max.livi.STOP_INCOMING_ACTIVITY_RINGTONE"
    const val PREFS_NAME = "LiviDeclinePrefs"
    @Volatile
    var ringtonePlayerForCallKeep: MediaPlayer? = null
      internal set
    /** Включить системный PiP при нажатии Home во время видеозвонка (окно поверх лаунчера). JS выставляет true при активном звонке или при показе in-app PiP. */
    @Volatile
    @JvmField
    var shouldEnterPiPOnLeaveHint = false
    @JvmStatic
    fun getShouldEnterPiPOnLeaveHint(): Boolean = shouldEnterPiPOnLeaveHint
    @JvmStatic
    internal fun setPiPOnLeaveHintEnabled(value: Boolean) {
      shouldEnterPiPOnLeaveHint = value
    }

    /** Пока true — не входить в системный PiP в onUserLeaveHint (JS ставит при завершении звонка, сбрасывает после). */
    @Volatile
    @JvmField
    var endingCallInProgress = false
    @JvmStatic
    fun getEndingCallInProgress(): Boolean = endingCallInProgress
    @JvmStatic
    internal fun setEndingCallInProgressStatic(value: Boolean) {
      endingCallInProgress = value
    }

    /** Параметры для завершения звонка из системного PiP (кнопка в окне PiP). */
    @Volatile var pipCallId: String? = null
      private set
    @Volatile var pipRoomId: String? = null
      private set
    const val ACTION_END_CALL_FROM_PIP = "com.kolt12max.livi.END_CALL_FROM_PIP"
    @JvmStatic
    fun setPiPEndCallParamsStatic(callId: String?, roomId: String?) {
      pipCallId = callId
      pipRoomId = roomId
    }
    @JvmStatic
    fun getPiPEndCallParamsStatic(promise: Promise) {
      val map = Arguments.createMap()
      map.putString("callId", pipCallId)
      map.putString("roomId", pipRoomId)
      promise.resolve(map)
    }
    @JvmStatic
    fun emitEndCallFromPiP() {
      reactContextRef?.runOnUiQueueThread {
        reactContextRef?.emitDeviceEvent("EndCallFromPiP", null)
      }
    }

    /** Уведомить JS, что скоро включится системный PiP — чтобы переключить UI на «только PiP» (видео собеседника + верхние кнопки) до входа в PiP.
     * decorWidth/decorHeight — размер decorView на момент вызова (до входа в PiP), чтобы JS не вызывал getDecorViewSize() после перехода (там уже размер окна PiP 334x594 и ломается отображение при повторном входе). */
    @JvmStatic
    fun emitAboutToEnterSystemPiP(decorWidth: Int = 0, decorHeight: Int = 0) {
      reactContextRef?.runOnUiQueueThread {
        if (decorWidth > 0 && decorHeight > 0) {
          val params = Arguments.createMap()
          params.putInt("width", decorWidth)
          params.putInt("height", decorHeight)
          reactContextRef?.emitDeviceEvent("AboutToEnterSystemPiP", params)
        } else {
          reactContextRef?.emitDeviceEvent("AboutToEnterSystemPiP", null)
        }
      }
    }

    /** Уведомить JS о входе/выходе из системного PiP (только видео + системная кнопка X, без кастомных кнопок). */
    @JvmStatic
    fun emitSystemPiPModeChanged(isInPiP: Boolean) {
      reactContextRef?.runOnUiQueueThread {
        val params = Arguments.createMap()
        params.putBoolean("isInPiP", isInPiP)
        reactContextRef?.emitDeviceEvent("SystemPiPModeChanged", params)
      }
    }

    /** Пользователь развернул PiP (стрелка или тап по окну) — активность на переднем плане. JS должен открыть экран видеозвонка. */
    @JvmStatic
    fun emitSystemPiPExpanded() {
      reactContextRef?.emitDeviceEvent("SystemPiPExpanded", null)
    }

    /** Запуск мелодии звонка и вибрации звонка из нативного кода (FGS, без React).
     * Системная мелодия звонка и вибрация звонка (не уведомления) — и при заблокированном, и при разблокированном экране. */
    @JvmStatic
    internal fun startIncomingCallRingtoneAndVibrationStatic(ctx: Context) {
      try {
        stopIncomingCallRingtoneAndVibrationStatic(ctx)
        val uri: Uri? = try {
          RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
        } catch (_: Exception) { null }
        if (uri != null) {
          val player = MediaPlayer().apply {
            setDataSource(ctx, uri)
            setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(
                  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    6 // AudioAttributes.USAGE_RINGTONE (API 29+)
                  } else {
                    AudioAttributes.USAGE_NOTIFICATION_RINGTONE
                  }
                )
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            )
            isLooping = true
            prepare()
            start()
          }
          ringtonePlayerForCallKeep = player
        }
        // Вибрация звонка (USAGE_RINGTONE) — и при заблокированном, и при разблокированном экране.
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
          @Suppress("DEPRECATION")
          ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        if (vibrator != null && vibrator.hasVibrator()) {
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
        }
      } catch (e: Exception) {
        Log.w(NAME, "startIncomingCallRingtoneAndVibrationStatic failed", e)
      }
    }

    /** Только общий MediaPlayer CallKeep/FGS — без vibrator.cancel и без STOP broadcast (экран IncomingCallActivity сам ведёт рингтон до ответа). */
    @JvmStatic
    internal fun stopRingtonePlayerForCallKeepOnly() {
      try {
        ringtonePlayerForCallKeep?.apply { if (isPlaying) stop(); release() }
        ringtonePlayerForCallKeep = null
      } catch (_: Exception) {}
    }

    /**
     * Перед стартом локального рингтона на IncomingCallActivity: глушим MediaPlayer FGS и вибратор
     * от FGS (без двойного звука/вибро). Без STOP broadcast: sendBroadcast асинхронный, иначе receiver
     * на Activity срабатывает уже после MediaPlayer.start() и сразу глушит мелодию (в фоне «сразу тихо»,
     * в приложении — нет ни звука, ни вибро).
     */
    @JvmStatic
    internal fun stopFgsHandoffForIncomingCallActivity(ctx: Context) {
      stopRingtonePlayerForCallKeepOnly()
      try {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
          @Suppress("DEPRECATION")
          ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        vibrator?.cancel()
      } catch (_: Exception) {}
    }

    @JvmStatic
    internal fun stopIncomingCallRingtoneAndVibrationStatic(ctx: Context) {
      try {
        ringtonePlayerForCallKeep?.apply { if (isPlaying) stop(); release() }
        ringtonePlayerForCallKeep = null
      } catch (_: Exception) {}
      try {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
          @Suppress("DEPRECATION")
          ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        vibrator?.cancel()
      } catch (_: Exception) {}
      try {
        val i = Intent(ACTION_STOP_INCOMING_ACTIVITY_RINGTONE).setPackage(ctx.packageName)
        ctx.sendBroadcast(i)
      } catch (_: Exception) {}
    }
    const val PREFS_CALL = "LiviCallPrefs"
    private const val PREFS_PENDING_MISSED = "LiviPendingMissed"
    private const val KEY_PENDING_MISSED_IDS = "user_ids"
    /** userId, недавно удалённые из pending через removePendingMissedCall (JS по сокету). Не добавлять их снова в pending при FCM, чтобы не дублировать инкремент. Формат "uid1:ts1,uid2:ts2". */
    private const val PREFS_PENDING_MISSED_REMOVED = "LiviPendingMissedRemoved"
    private const val KEY_REMOVED_UID_TS = "uid_ts"
    private const val REMOVED_EXPIRY_MS = 30_000L
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
    const val KEY_USER_ID_FOR_DECLINE = "user_id_for_decline"
    const val KEY_OUTGOING_CALL_TIMEOUT_MS = "outgoing_call_timeout_ms"
    private const val PREFS_OPEN_TAB = "LiviOpenTab"
    private const val KEY_PENDING_OPEN_TAB_FRIENDS = "pending_open_tab_friends"
    private const val HEADLESS_TASK_CALL_KEEP = "RNCallKeepBackgroundMessage"

    private var reactContextRef: ReactApplicationContext? = null

    @JvmStatic
    fun normalizeApiServerBase(raw: String?): String? {
      val trimmed = raw?.trim()?.removeSuffix("/") ?: return null
      if (trimmed.isEmpty()) return null
      return if (trimmed.endsWith("/api")) trimmed.removeSuffix("/api") else trimmed
    }

    /** Приоритет: prefs (последняя синхронизация из JS) -> BuildConfig.API_BASE_URL -> production fallback. */
    @JvmStatic
    fun resolveServerBaseUrl(context: Context): String? {
      val prefsUrl = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .getString(KEY_SERVER_URL, null)
      normalizeApiServerBase(prefsUrl)?.let { return it }
      normalizeApiServerBase(BuildConfig.API_BASE_URL)?.let { return it }
      return "https://api.liviapp.com"
    }

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

    /** Вызвать из LiviFirebaseMessagingService при показе «Пропущенный вызов» — чтобы при открытии приложения JS обновил счётчик и бейдж. Не добавляем, если JS уже учёл по сокету (wasPendingMissedRecentlyRemoved). */
    @JvmStatic
    fun addPendingMissedCall(context: Context, userId: String) {
      if (userId.isBlank()) return
      if (wasPendingMissedRecentlyRemoved(context, userId)) return
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

    /** Удалить userId из списка pending пропущенных (чтобы при следующем getAndClearPendingMissedCalls не дублировать инкремент). Вызывать из JS после инкремента по сокету call:timeout. Записываем userId в «недавно удалён», чтобы FCM, пришедший позже сокета, не добавил его снова. */
    @JvmStatic
    fun removePendingMissedCall(context: Context, userId: String) {
      if (userId.isBlank()) return
      val prefs = context.getSharedPreferences(PREFS_PENDING_MISSED, Context.MODE_PRIVATE)
      val current = prefs.getString(KEY_PENDING_MISSED_IDS, "") ?: ""
      val key = userId.trim()
      if (current.isNotEmpty()) {
        val list = current.split(',').map { it.trim() }.filter { it.isNotEmpty() }.filter { it != key }
        prefs.edit().putString(KEY_PENDING_MISSED_IDS, list.joinToString(",")).apply()
      }
      val removedPrefs = context.getSharedPreferences(PREFS_PENDING_MISSED_REMOVED, Context.MODE_PRIVATE)
      val removedRaw = removedPrefs.getString(KEY_REMOVED_UID_TS, "") ?: ""
      val now = System.currentTimeMillis()
      val entries = (if (removedRaw.isEmpty()) emptyList() else removedRaw.split(',')).mapNotNull { s ->
        val parts = s.split(':')
        if (parts.size >= 2) {
          val ts = parts[1].toLongOrNull() ?: 0L
          if (now - ts <= REMOVED_EXPIRY_MS) parts[0].trim() to ts else null
        } else null
      }.toMutableList()
      entries.add(key to now)
      removedPrefs.edit().putString(KEY_REMOVED_UID_TS, entries.takeLast(20).joinToString(",") { "${it.first}:${it.second}" }).apply()
    }

    /** Был ли userId недавно удалён из pending (removePendingMissedCall)? Тогда не добавлять снова при FCM. */
    @JvmStatic
    fun wasPendingMissedRecentlyRemoved(context: Context, userId: String): Boolean {
      if (userId.isBlank()) return false
      val removedPrefs = context.getSharedPreferences(PREFS_PENDING_MISSED_REMOVED, Context.MODE_PRIVATE)
      val raw = removedPrefs.getString(KEY_REMOVED_UID_TS, "") ?: ""
      val now = System.currentTimeMillis()
      for (s in raw.split(',')) {
        val parts = s.split(':')
        if (parts.size >= 2 && parts[0].trim() == userId.trim()) {
          val ts = parts[1].toLongOrNull() ?: 0L
          if (now - ts <= REMOVED_EXPIRY_MS) return true
          return false
        }
      }
      return false
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
      prefs.edit().putString(KEY_MISSED_COUNT_BY_USER, map.toString()).commit()
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

    /** Стабильный ID уведомления о сообщениях от пользователя — одно уведомление на чат (группировка по отправителю). */
    @JvmStatic
    fun getMessageNotificationIdForUser(userId: String): Int {
      if (userId.isBlank()) return LiviFirebaseMessagingService.NOTIFICATION_ID_MESSAGE_BASE
      return LiviFirebaseMessagingService.NOTIFICATION_ID_MESSAGE_BASE + (userId.hashCode() and 0x7FFF)
    }

    /** Вернуть JSON счётчиков пропущенных по пользователям из нативного хранилища (источник истины при FCM). Формат: {"userId": count}. Для синхронизации с JS при фокусе. */
    @JvmStatic
    fun getMissedCountByUserJson(context: Context): String {
      val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
      return prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
    }

    /** Суммарное число пропущенных по всем пользователям (из нативного хранилища). Для обновления бейджа иконки из FCM без JS. */
    @JvmStatic
    fun getTotalMissedCount(context: Context): Int {
      val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_MISSED_COUNT_BY_USER, "{}") ?: "{}"
      val map = try {
        JSONObject(raw)
      } catch (_: Exception) {
        return 0
      }
      var total = 0
      val it = map.keys()
      while (it.hasNext()) {
        total += map.optInt(it.next(), 0).coerceAtLeast(0)
      }
      return total
    }

    /** Обновить бейдж на иконке приложения по нативному счётчику пропущенных. Вызывать из FCM после showMissedCallNotification/recordMissedCallStateOnly. Не вызываем setBadgeCount(0), чтобы не триггерить cancelAll() в BadgeHelper. */
    @JvmStatic
    fun updateAppIconBadgeFromMissedCount(context: Context) {
      try {
        val total = getTotalMissedCount(context).coerceIn(0, 99)
        if (total > 0) BadgeHelper.setBadgeCount(context.applicationContext, total)
      } catch (_: Exception) {}
    }

    /** Обновить бейдж при получении FCM сообщения: unreadCount из пуша + пропущенные из нативного хранилища. */
    @JvmStatic
    fun updateAppIconBadgeFromUnreadAndMissed(context: Context, unreadCount: Int) {
      try {
        val missed = getTotalMissedCount(context)
        val total = (unreadCount.coerceAtLeast(0) + missed).coerceIn(0, 99)
        BadgeHelper.setBadgeCount(context.applicationContext, total)
      } catch (_: Exception) {}
    }

    /** Очистить все счётчики пропущенных в нативном хранилище и выставить бейдж в 0. После этого при новом FCM бейдж будет считаться только по unreadCount из пуша. */
    @JvmStatic
    fun clearAllMissedCountsAndSetBadgeZeroStatic(context: Context) {
      try {
        val prefs = context.getSharedPreferences(PREFS_MISSED_COUNT, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_MISSED_COUNT_BY_USER, "{}").apply()
        BadgeHelper.setBadgeCount(context.applicationContext, 0)
      } catch (_: Exception) {}
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

    /** Входящий для CallKeep (FCM при разблокированном экране): сохранить в pending; JS вызовет getAndClearPendingIncomingCallForCallKeep → displayIncomingCall. */
    @Volatile private var pendingCallKeepCallId: String? = null
    @Volatile private var pendingCallKeepFrom: String? = null
    @Volatile private var pendingCallKeepFromNick: String? = null

    @JvmStatic
    fun setPendingIncomingCallForCallKeep(callId: String, from: String, fromNick: String) {
      pendingCallKeepCallId = callId
      pendingCallKeepFrom = from
      pendingCallKeepFromNick = fromNick ?: ""
    }

    @JvmStatic
    fun getAndClearPendingIncomingCallForCallKeep(): Triple<String, String, String>? {
      val c = pendingCallKeepCallId ?: return null
      val f = pendingCallKeepFrom ?: return null
      val n = pendingCallKeepFromNick ?: ""
      pendingCallKeepCallId = null
      pendingCallKeepFrom = null
      pendingCallKeepFromNick = null
      return Triple(c, f, n)
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
