package com.kolt12max.livi

import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {

  private val pipHandler = Handler(Looper.getMainLooper())
  private var exitedPipPending = false
  private var exitPipTimeoutRunnable: Runnable? = null

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
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
  }

  override fun onResume() {
    super.onResume()
    isInForeground = true
    // Выход из системного PiP по кнопке «развернуть»: onResume приходит когда активность снова на переднем плане.
    if (exitedPipPending) {
      exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
      exitPipTimeoutRunnable = null
      exitedPipPending = false
      android.util.Log.i("MainActivity", "PiP exit: onResume first -> emitting SystemPiPExpanded")
      LiviAppModule.emitSystemPiPExpanded()
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
   * При Home во время звонка уведомляем JS, затем входим в системный PiP.
   * JS пытается войти в PiP после обновления UI; ниже оставляем нативный fallback, если JS не успел.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && LiviAppModule.getShouldEnterPiPOnLeaveHint()) {
      try {
        LiviAppModule.emitAboutToEnterSystemPiP()
        val handler = Handler(Looper.getMainLooper())
        val tryEnterPiP = Runnable {
          try {
            if (isInPictureInPictureMode) return@Runnable
            if (!LiviAppModule.getShouldEnterPiPOnLeaveHint()) return@Runnable
            val ratio = Rational(150, 260)
            val params = PictureInPictureParams.Builder()
              .setAspectRatio(ratio)
              .setActions(emptyList<RemoteAction>())
              .build()
            if (enterPictureInPictureMode(params)) {
              android.util.Log.d("MainActivity", "Entered Picture-in-Picture mode (leaveHint)")
            } else {
              android.util.Log.w("MainActivity", "leaveHint enterPictureInPictureMode returned false")
            }
          } catch (e2: Exception) {
            android.util.Log.w("MainActivity", "leaveHint enterPictureInPictureMode failed", e2)
          }
        }
        // Быстрая попытка — чтобы PiP появлялся быстрее после Home.
        handler.postDelayed(tryEnterPiP, 60)
        // Надёжный fallback, если быстрая попытка не успела/не сработала.
        handler.postDelayed(tryEnterPiP, 160)
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "emitAboutToEnterSystemPiP failed", e)
      }
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      LiviAppModule.emitSystemPiPModeChanged(isInPictureInPictureMode)
      if (!isInPictureInPictureMode) {
        // Различие «развернуть» (стрелки) и «закрыть» (X): при развороте приходит onResume, при закрытии — нет.
        // Ставим флаг и таймаут: если до таймаута придёт onResume — шлём SystemPiPExpanded, иначе EndCallFromPiP.
        exitedPipPending = true
        exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
        exitPipTimeoutRunnable = Runnable {
          if (exitedPipPending) {
            exitedPipPending = false
            exitPipTimeoutRunnable = null
            android.util.Log.i("MainActivity", "PiP exit: no onResume in time -> emitting EndCallFromPiP")
            LiviAppModule.emitEndCallFromPiP()
          }
        }
        pipHandler.postDelayed(exitPipTimeoutRunnable!!, 1200)
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
    // Кнопка Домой свернула приложение во время звонка → при тапе по иконке снова показываем экран звонка, а не главный.
    if (isLaunchedFromLauncher(intent) && LiviOngoingCallHelper.launchOngoingCallActivityIfNeeded(this)) {
      finish()
    }
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
    const val EXTRA_OPEN_TAB_FRIENDS = "open_tab_friends"

    /** true когда приложение на переднем плане (в т.ч. во время видеозвонка) — тогда не показываем heads-up уведомление о звонке */
    @JvmField
    var isInForeground = false
  }
}
