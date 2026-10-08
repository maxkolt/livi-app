package com.kolt12max.livi

import android.content.ComponentName
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

/**
 * «Поделиться» из другого приложения — отдельное окно, а не главное LiVi: своя пустая
 * задача (taskAffinity=""), нет в «Недавних», закрывается finish() — и пользователь снова
 * в приложении, из которого делился. Главная задача LiVi не поднимается ни до, ни после
 * отправки, даже если приложение было закрыто. JS-корень — "LiviShare" (components/share).
 */
class ShareActivity : ReactActivity() {
  /**
   * Dev-клиент Expo грузит JS только через главное окно: при холодном старте эта активити
   * навсегда осталась бы на его заставке. В debug без живого React отдаём «Поделиться»
   * главному окну (прежний путь), а сами JS не грузим. В релизе — всегда сами.
   */
  private fun forwardToMain(): Boolean = BuildConfig.DEBUG && !LiviAppModule.hasActiveReactInstance()

  // Функция, а не поле: ReactActivity зовёт её из своего конструктора, раньше полей подкласса.
  // null — ReactActivityDelegate не запускает JS-приложение.
  override fun getMainComponentName(): String? = if (forwardToMain()) null else "LiviShare"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    val name = mainComponentName
    // Без имени — базовый делегат: он принимает null и ничего не запускает.
    val inner =
      if (name == null) ReactActivityDelegate(this, null)
      else object : DefaultReactActivityDelegate(this, name, fabricEnabled) {}
    return ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, inner)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Прозрачная тема — без системной заставки с иконкой; фон окна сразу свой (HOME_NAV_BG),
    // пока JS поднимает экран отправки.
    setTheme(R.style.Theme_App_Translucent)
    if (mainComponentName == null) {
      super.onCreate(null)
      try {
        startActivity(
          Intent(intent)
            .setComponent(ComponentName(this, MainActivity::class.java))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (e: Exception) {
        android.util.Log.w("ShareActivity", "forward to MainActivity failed", e)
      }
      finish()
      return
    }
    stashShare(intent)
    super.onCreate(null)
    window.setBackgroundDrawable(ColorDrawable(getColor(R.color.home_nav_background)))
    EdgeToEdgeHelper.apply(this)
    liveInstance = this
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (stashShare(intent)) LiviAppModule.emitShareActivityItems()
  }

  override fun onDestroy() {
    if (liveInstance === this) liveInstance = null
    super.onDestroy()
  }

  private fun stashShare(i: Intent?): Boolean {
    if (!ShareIntentHandler.isShareIntent(i)) return false
    return try {
      ShareIntentHandler.stashFromIntent(applicationContext, i!!)
    } catch (e: Exception) {
      android.util.Log.w("ShareActivity", "stashShare failed", e)
      false
    }
  }

  companion object {
    @JvmStatic
    @Volatile
    var liveInstance: ShareActivity? = null
  }
}
