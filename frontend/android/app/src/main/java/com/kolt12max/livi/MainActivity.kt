package com.kolt12max.livi

import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import androidx.activity.OnBackPressedCallback

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {

  override fun attachBaseContext(newBase: Context) {
    super.attachBaseContext(FontScaleContextHelper.wrap(newBase))
  }

  override fun applyOverrideConfiguration(overrideConfiguration: Configuration?) {
    if (overrideConfiguration != null) {
      super.applyOverrideConfiguration(FontScaleContextHelper.copyPatched(overrideConfiguration))
    } else {
      super.applyOverrideConfiguration(null)
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(FontScaleContextHelper.copyPatched(newConfig))
  }

  // Выход из системного PiP: «развернуть» (стрелки) даёт onResume, «закрыть X» — нет. Ставим таймер (pipExitDecideMs):
  // если за это время придёт onResume — шлём SystemPiPExpanded (JS открывает экран звонка), иначе EndCallFromPiP.
  // expandedEmittedForPipExit нужен, чтобы таймер не слал EndCallFromPiP, если мы уже отправили expand.
  private val pipHandler = Handler(Looper.getMainLooper())
  private var exitedPipPending = false
  private var exitPipTimeoutRunnable: Runnable? = null
  private var wasInPip = false
  private var expandedEmittedForPipExit = false
  private val pipExitDecideMs = 2500L

  /** Закрыть системный PiP при пуше call_ended (endedFromActive): собеседник в PiP не получает call:ended по сокету — пуш доходит, закрываем окно сразу. */
  private var closePipCallEndedReceiver: BroadcastReceiver? = null
  private var backPressLoggingCallback: OnBackPressedCallback? = null
  /** Был intent с EXTRA_PENDING_ANSWER_* — в onResume шлём LiviPendingAnswerCall (один раз на доставку). */
  private var pendingAnswerFromIntent = false

  private fun tryStashPendingAnswerFromIntent(i: Intent?): Boolean {
    if (i == null) return false
    val callId = i.getStringExtra(EXTRA_PENDING_ANSWER_CALL_ID) ?: return false
    val from = i.getStringExtra(EXTRA_PENDING_ANSWER_FROM) ?: return false
    if (callId.isBlank() || from.isBlank()) return false
    val fromNick = i.getStringExtra(EXTRA_PENDING_ANSWER_FROM_NICK) ?: ""
    LiviAppModule.setPendingAnswerCall(callId, from, fromNick)
    i.removeExtra(EXTRA_PENDING_ANSWER_CALL_ID)
    i.removeExtra(EXTRA_PENDING_ANSWER_FROM)
    i.removeExtra(EXTRA_PENDING_ANSWER_FROM_NICK)
    return true
  }

  private fun buildSystemPiPSourceRect(): Rect? {
    return try {
      val root = window?.decorView ?: return null
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

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // FCM call_accepted при уже запущенной MainActivity — сохранить callId для JS (onResume вызовет emitPendingCallAcceptedEvent).
    val pendingCallId = intent.getStringExtra(EXTRA_PENDING_CALL_ACCEPTED_CALL_ID)
    if (!pendingCallId.isNullOrBlank()) {
      LiviAppModule.setPendingCallAcceptedCallId(pendingCallId)
    }
    // FCM входящий при разблокированном экране — показать через CallKeep (ConnectionService)
    if (intent.action == LiviAppModule.ACTION_INCOMING_CALL_CALLKEEP) {
      val callId = intent.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
      val from = intent.getStringExtra(IncomingCallActivity.EXTRA_FROM)
      val fromNick = intent.getStringExtra(IncomingCallActivity.EXTRA_FROM_NICK) ?: ""
      if (!callId.isNullOrBlank() && !from.isNullOrBlank()) {
        LiviAppModule.setPendingIncomingCallForCallKeep(callId, from, fromNick)
      }
    }
    // Тап по уведомлению «Пропущенный вызов» (приложение уже было в фоне) — сразу снимаем уведомления
    if (intent.getBooleanExtra(EXTRA_OPEN_TAB_FRIENDS, false)) {
      intent.removeExtra(EXTRA_OPEN_TAB_FRIENDS)
      LiviAppModule.dismissAllMissedCallNotificationsFromContext(this)
      LiviAppModule.setPendingOpenTabFriends(this)
    }
    if (tryStashPendingAnswerFromIntent(intent)) {
      pendingAnswerFromIntent = true
    }
  }

  private fun emitSystemPiPExpandedOnce(reason: String) {
    exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
    exitPipTimeoutRunnable = null
    exitedPipPending = false
    wasInPip = false
    expandedEmittedForPipExit = true
    LiviAppModule.setPiPOnLeaveHintEnabled(false)
    android.util.Log.i("MainActivity", "PiP exit: $reason -> emitting SystemPiPExpanded")
    LiviAppModule.emitSystemPiPExpanded()
  }

  override fun onResume() {
    super.onResume()
    isInForeground = true
    // Выход из системного PiP по кнопке «развернуть»: надёжно обрабатываем только тот resume,
    // который пришёл после onPictureInPictureModeChanged(false). Старый fallback по wasInPip
    // давал ложный SystemPiPExpanded во время Home -> system PiP на части устройств.
    if (exitedPipPending) {
      emitSystemPiPExpandedOnce("onResume")
    }
    restoreNavigationBarVisibility()
    // Тап по уведомлению «Пропущенный вызов» — снять уведомления из шторки и открыть вкладку Друзья (здесь срабатывает и при холодном старте — activity уже готова)
    if (intent?.getBooleanExtra(EXTRA_OPEN_TAB_FRIENDS, false) == true) {
      intent?.removeExtra(EXTRA_OPEN_TAB_FRIENDS)
      LiviAppModule.setPendingOpenTabFriends(this)
      // Сразу и с небольшой задержкой: на части устройств при холодном старте cancel в первый момент не срабатывает
      LiviAppModule.dismissAllMissedCallNotificationsFromContext(this)
      Handler(Looper.getMainLooper()).postDelayed({
        LiviAppModule.dismissAllMissedCallNotificationsFromContext(this@MainActivity)
      }, 150)
    }
    // FCM call_accepted запустил MainActivity — закрыть нативный экран исходящего (если ещё открыт) и уведомить JS
    val pendingCallId = intent?.getStringExtra(EXTRA_PENDING_CALL_ACCEPTED_CALL_ID)
    if (!pendingCallId.isNullOrBlank()) {
      intent?.removeExtra(EXTRA_PENDING_CALL_ACCEPTED_CALL_ID)
      val closeOutgoing = Intent(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL).apply {
        setPackage(packageName)
        putExtra(OutgoingCallActivity.EXTRA_CALL_ID, pendingCallId)
      }
      sendBroadcast(closeOutgoing)
      LiviAppModule.emitPendingCallAcceptedEvent()
    }
    if (pendingAnswerFromIntent && LiviAppModule.hasPendingAnswerCall()) {
      pendingAnswerFromIntent = false
      LiviAppModule.emitPendingAnswerCallEvent()
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // После ответа/отмены вызова из IncomingCallActivity на части устройств
    // пропадает кнопка «Недавние» (три полоски). Явно восстанавливаем отображение
    // системной навигационной панели при получении фокуса.
    if (hasFocus) {
      restoreNavigationBarVisibility()
    }
  }

  private fun restoreNavigationBarVisibility() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.insetsController?.apply {
        show(android.view.WindowInsets.Type.navigationBars())
        systemBarsBehavior = android.view.WindowInsetsController.BEHAVIOR_DEFAULT
      }
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility = 0
    }
  }

  override fun onPause() {
    super.onPause()
    isInForeground = false
  }

  /**
   * При Home во время звонка сначала просим JS подготовить dedicated fullscreen-host
   * для system PiP capture, а затем несколько раз пробуем войти в PiP нативно.
   * Так поведение остаётся таким же стабильным, как раньше, но кадр берётся уже
   * из отдельного fullscreen-host, а не из маленького in-app PiP.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    val endingCallInProgress = LiviAppModule.getEndingCallInProgress()
    val shouldEnterPiP = LiviAppModule.getShouldEnterPiPOnLeaveHint()
    val inAppPiPVisible = LiviAppModule.getInAppPiPVisibleForSystemPiP()
    android.util.Log.i(
      "MainActivity",
      "onUserLeaveHint: sdk=${Build.VERSION.SDK_INT} endingCallInProgress=$endingCallInProgress shouldEnterPiP=$shouldEnterPiP inAppPiPVisible=$inAppPiPVisible isInPiP=$isInPictureInPictureMode hasFocus=${window?.decorView?.hasWindowFocus() == true}"
    )
    if (endingCallInProgress) {
      android.util.Log.i("MainActivity", "onUserLeaveHint: skip system PiP because endingCallInProgress=true")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && shouldEnterPiP) {
      try {
        android.util.Log.i("MainActivity", "onUserLeaveHint: requesting JS system PiP capture preparation")
        val root = window?.decorView
        val decorW = root?.width ?: 0
        val decorH = root?.height ?: 0
        LiviAppModule.emitAboutToEnterSystemPiP(decorW, decorH)
        val handler = Handler(Looper.getMainLooper())
        val tryEnterPiP = Runnable {
          try {
            if (isInPictureInPictureMode) return@Runnable
            if (LiviAppModule.getEndingCallInProgress()) return@Runnable
            if (!LiviAppModule.getShouldEnterPiPOnLeaveHint()) {
              android.util.Log.i("MainActivity", "onUserLeaveHint: skip retry because shouldEnterPiPOnLeaveHint=false")
              return@Runnable
            }
            val ratio = Rational(9, 16)
            val builder = PictureInPictureParams.Builder()
              .setAspectRatio(ratio)
              .setActions(emptyList<RemoteAction>())
            val sourceRect = buildSystemPiPSourceRect()
            if (sourceRect != null) {
              builder.setSourceRectHint(sourceRect)
            }
            val params = builder.build()
            if (enterPictureInPictureMode(params)) {
              android.util.Log.d("MainActivity", "Entered Picture-in-Picture mode (leaveHint)")
            } else {
              android.util.Log.w("MainActivity", "leaveHint enterPictureInPictureMode returned false")
            }
          } catch (e2: Exception) {
            android.util.Log.w("MainActivity", "leaveHint enterPictureInPictureMode failed", e2)
          }
        }
        // Для direct VideoCall -> Home нужен самый ранний вход, иначе активность может успеть уйти в фон.
        // Для Back -> in-app PiP -> Home fullscreen capture-host теперь prewarm-ится ещё во время in-app PiP,
        // поэтому на leaveHint можно снова пробовать ранний native enter — это критично для более медленных устройств.
        if (!inAppPiPVisible) {
          android.util.Log.i("MainActivity", "onUserLeaveHint: direct path, running tryEnterPiP immediately")
          tryEnterPiP.run()
        } else {
          android.util.Log.i("MainActivity", "onUserLeaveHint: in-app PiP path, running prewarmed tryEnterPiP immediately")
          tryEnterPiP.run()
        }
        if (!isInPictureInPictureMode) {
          if (!inAppPiPVisible) {
            android.util.Log.i("MainActivity", "onUserLeaveHint: scheduling direct-path retries")
            handler.post(tryEnterPiP)
            handler.postDelayed(tryEnterPiP, 80)
            handler.postDelayed(tryEnterPiP, 180)
            handler.postDelayed(tryEnterPiP, 320)
            handler.postDelayed(tryEnterPiP, 450)
          } else {
            android.util.Log.i("MainActivity", "onUserLeaveHint: scheduling prewarmed in-app PiP retries")
            handler.post(tryEnterPiP)
            handler.postDelayed(tryEnterPiP, 80)
            handler.postDelayed(tryEnterPiP, 180)
            handler.postDelayed(tryEnterPiP, 320)
            handler.postDelayed(tryEnterPiP, 450)
          }
          handler.postDelayed(tryEnterPiP, 800)
          handler.postDelayed(tryEnterPiP, 1200)
        }
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "emitAboutToEnterSystemPiP failed", e)
      }
    } else {
      android.util.Log.i(
        "MainActivity",
        "onUserLeaveHint: skip system PiP because shouldEnterPiPOnLeaveHint=false or sdk<26"
      )
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (isInPictureInPictureMode) {
        window.setBackgroundDrawableResource(android.R.color.transparent)
        // Вход в PiP: отменяем таймер «выход из PiP», иначе на части устройств через таймаут срабатывает EndCallFromPiP.
        exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
        exitPipTimeoutRunnable = null
        exitedPipPending = false
        expandedEmittedForPipExit = false
        wasInPip = true
      }
      LiviAppModule.emitSystemPiPModeChanged(isInPictureInPictureMode)
      if (!isInPictureInPictureMode) {
        // Сразу отключаем вход в PiP по onUserLeaveHint — на части устройств onUserLeaveHint
        // приходит во время перехода PiP→fullscreen до onResume; иначе приложение снова уходит в PiP.
        LiviAppModule.setPiPOnLeaveHintEnabled(false)
        // Различие «развернуть» (стрелки) и «закрыть» (X): при развороте приходит onResume, при закрытии — нет.
        // Ставим флаг и таймаут: если до таймаута придёт onResume — шлём SystemPiPExpanded, иначе EndCallFromPiP.
        // expandedEmittedForPipExit предотвращает EndCallFromPiP, если мы уже отправили expand (на части устройств onResume приходит после onPictureInPictureModeChanged).
        exitedPipPending = true
        exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
        exitPipTimeoutRunnable = Runnable {
          if (exitedPipPending && !expandedEmittedForPipExit) {
            exitedPipPending = false
            wasInPip = false
            exitPipTimeoutRunnable = null
            val hasFocusNow = window?.decorView?.hasWindowFocus() == true
            if (isInForeground && hasFocusNow) {
              android.util.Log.i(
                "MainActivity",
                "PiP exit: timeout but app foreground+focused -> treating as return, emitting SystemPiPExpanded"
              )
              emitSystemPiPExpandedOnce("pipExit:timeout+foreground")
              return@Runnable
            }
            android.util.Log.i("MainActivity", "PiP exit: no onResume in time -> emitting EndCallFromPiP")
            LiviAppModule.emitEndCallFromPiP()
          }
        }
        pipHandler.postDelayed(exitPipTimeoutRunnable!!, pipExitDecideMs)
        val hasFocus = window?.decorView?.hasWindowFocus() == true
        if (isInForeground && hasFocus) {
          emitSystemPiPExpandedOnce("modeChanged(false)+foreground")
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // При запуске по livi://decline-call — прозрачная тема: пользователь видит экран блокировки/лаунчер, не страницу приветствия.
    if (isDeclineCallIntent(intent)) {
      setTheme(R.style.Theme_App_Translucent)
    } else {
      setTheme(R.style.AppTheme)
    }
    super.onCreate(null)
    if (backPressLoggingCallback == null) {
      backPressLoggingCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          android.util.Log.i(
            "MainActivity",
            "System back pressed: route delegated to React Native / activity handler; isInPiP=$isInPictureInPictureMode hasFocus=${window?.decorView?.hasWindowFocus() == true}"
          )
          isEnabled = false
          try {
            onBackPressedDispatcher.onBackPressed()
          } finally {
            isEnabled = true
          }
        }
      }
      onBackPressedDispatcher.addCallback(this, backPressLoggingCallback!!)
    }
    // FCM входящий при разблокированном экране (холодный старт) — сохраняем для CallKeep
    if (intent?.action == LiviAppModule.ACTION_INCOMING_CALL_CALLKEEP) {
      val callId = intent.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
      val from = intent.getStringExtra(IncomingCallActivity.EXTRA_FROM)
      val fromNick = intent.getStringExtra(IncomingCallActivity.EXTRA_FROM_NICK) ?: ""
      if (!callId.isNullOrBlank() && !from.isNullOrBlank()) {
        LiviAppModule.setPendingIncomingCallForCallKeep(callId, from, fromNick)
      }
    }
    // Тап по уведомлению «Пропущенный вызов»: ставим флаг для JS; снятие уведомлений из шторки — в onResume (при холодном старте в onCreate система уведомлений может быть ещё не готова).
    if (intent?.getBooleanExtra(EXTRA_OPEN_TAB_FRIENDS, false) == true) {
      LiviAppModule.setPendingOpenTabFriends(this)
    }
    if (tryStashPendingAnswerFromIntent(intent)) {
      pendingAnswerFromIntent = true
    }
    // Кнопка Домой свернула приложение во время звонка → при тапе по иконке снова показываем экран звонка, а не главный.
    if (isLaunchedFromLauncher(intent) && LiviOngoingCallHelper.launchOngoingCallActivityIfNeeded(this)) {
      finish()
    }
    // Пуш call_ended (endedFromActive): закрыть PiP сразу у собеседника, т.к. сокет в фоне часто отключён.
    closePipCallEndedReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != LiviFirebaseMessagingService.ACTION_CLOSE_PIP_CALL_ENDED) return
        (context as? MainActivity)?.runOnUiThread {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && (context as MainActivity).isInPictureInPictureMode) {
            (context as MainActivity).finish()
            android.util.Log.d("MainActivity", "Close PiP from call_ended push (endedFromActive)")
          }
        }
      }
    }
    val closePipFilter = IntentFilter(LiviFirebaseMessagingService.ACTION_CLOSE_PIP_CALL_ENDED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(closePipCallEndedReceiver, closePipFilter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(closePipCallEndedReceiver, closePipFilter)
    }
  }

  override fun onDestroy() {
    closePipCallEndedReceiver?.let {
      try { unregisterReceiver(it) } catch (_: Exception) {}
      closePipCallEndedReceiver = null
    }
    super.onDestroy()
  }

  /** Запуск из лаунчера (тап по иконке), не по deep link (livi://...). */
  private fun isLaunchedFromLauncher(i: Intent?): Boolean {
    if (i?.action != Intent.ACTION_MAIN) return false
    if (i.categories?.contains(Intent.CATEGORY_LAUNCHER) != true) return false
    val data = i.data ?: return true
    return data.scheme != "livi"
  }

  private fun isDeclineCallIntent(i: Intent?): Boolean {
    val data: Uri? = i?.data ?: return false
    if (i.action != Intent.ACTION_VIEW) return false
    return data?.scheme == "livi" && data?.host == "decline-call"
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }

  companion object {
    const val EXTRA_PENDING_CALL_ACCEPTED_CALL_ID = "pending_call_accepted_call_id"
    const val EXTRA_PENDING_ANSWER_CALL_ID = "pending_answer_call_id"
    const val EXTRA_PENDING_ANSWER_FROM = "pending_answer_from"
    const val EXTRA_PENDING_ANSWER_FROM_NICK = "pending_answer_from_nick"
    const val EXTRA_OPEN_TAB_FRIENDS = "open_tab_friends"

    /** true когда приложение на переднем плане (в т.ч. во время видеозвонка) — тогда не показываем heads-up уведомление о звонке */
    @JvmField
    var isInForeground = false
  }
}
