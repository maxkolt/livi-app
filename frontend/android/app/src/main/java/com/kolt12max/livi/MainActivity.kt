package com.kolt12max.livi

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.res.Configuration
import android.graphics.drawable.Icon
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
   * При нажатии кнопки Home во время видеозвонка — переводим активность в системный PiP,
   * чтобы окно звонка было видно поверх лаунчера и других приложений (как в WhatsApp/Telegram).
   * Сначала уведомляем JS (AboutToEnterSystemPiP), чтобы переключить экран на «только PiP» (видео собеседника + верхние кнопки),
   * затем с задержкой входим в PiP — тогда в окне будет только компактный PiP, а не весь экран видеозвонка.
   * Кнопка «Завершить» в окне PiP шлёт broadcast END_CALL_FROM_PIP → JS завершает звонок.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && LiviAppModule.getShouldEnterPiPOnLeaveHint()) {
      try {
        LiviAppModule.emitAboutToEnterSystemPiP()
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
          try {
            val ratio = Rational(150, 260)
            val builder = PictureInPictureParams.Builder().setAspectRatio(ratio)
            val pipIntent = Intent(LiviAppModule.ACTION_END_CALL_FROM_PIP).setPackage(packageName)
            val pending = PendingIntent.getBroadcast(
              this, 0, pipIntent,
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val icon = Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel)
            val endAction = RemoteAction(icon, getString(R.string.pip_action_end_call), getString(R.string.pip_action_end_call), pending)
            builder.setActions(listOf(endAction))
            val params = builder.build()
            if (enterPictureInPictureMode(params)) {
              android.util.Log.d("MainActivity", "Entered Picture-in-Picture mode")
            }
          } catch (e: Exception) {
            android.util.Log.w("MainActivity", "enterPictureInPictureMode failed", e)
          }
        }, 280)
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "emitAboutToEnterSystemPiP failed", e)
      }
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      LiviAppModule.emitSystemPiPModeChanged(isInPictureInPictureMode)
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
