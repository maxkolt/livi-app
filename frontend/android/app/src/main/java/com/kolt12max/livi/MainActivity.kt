package com.kolt12max.livi

import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import com.facebook.react.uimanager.util.ReactFindViewUtil

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  private var lastReportedImeInset = -1
  /** Затемнение боковой панели навигации в landscape (см. reportNavBarSideInsets). */
  private var sideNavScrim: View? = null
  private var sideNavScrimSpec: Pair<Int, Int>? = null

  /**
   * Exposes the platform's actual IME inset to JS. This avoids screen-coordinate
   * calculations, which differ between edge-to-edge OEM implementations.
   */
  private fun observeImeInsets() {
    val root = window?.decorView ?: return
    fun reportImeInsets(insets: WindowInsetsCompat) {
      reportNavBarSideInsets(insets)
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      val imeInsetPx = if (imeVisible) {
        insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      } else {
        0
      }
      // В те же dp, что RN layout, используя текущую плотность экрана
      // из системных настроек, а не physical/stable density устройства.
      val density = resources.displayMetrics.density.coerceAtLeast(0.01f)
      val imeBottomDp = kotlin.math.round(imeInsetPx / density).toInt()
      if (imeBottomDp != lastReportedImeInset) {
        lastReportedImeInset = imeBottomDp
        LiviAppModule.emitAndroidImeInsets(imeBottomDp)
      }
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      reportImeInsets(insets)
      insets
    }
    // React Native may replace the decor inset listener while it mounts. Global
    // layout remains stable and re-reads the latest root insets on every IME move.
    root.viewTreeObserver.addOnGlobalLayoutListener {
      ViewCompat.getRootWindowInsets(root)?.let(::reportImeInsets)
    }
    ViewCompat.requestApplyInsets(root)
  }

  /**
   * В landscape панель с кнопками стоит сбоку, и RN-контент под неё не заходит — там
   * виден фон окна (та же сцена, что и в JS). Кладём поверх панели полосу с тем же
   * затемнением, что SystemBarsScrim рисует под строкой состояния.
   * Сам фон окна не перекрашиваем: при повороте RN ещё ~полсекунды рисует старую
   * раскладку, и всё остальное окно становилось почти чёрным — экран делился на два тона.
   */
  private fun reportNavBarSideInsets(insets: WindowInsetsCompat) {
    val decor = window?.decorView as? ViewGroup ?: return
    val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
    val width = if (nav.right > 0) nav.right else nav.left
    val gravity = if (nav.right > 0) Gravity.END else Gravity.START
    // Зовётся на каждый global layout — трогаем view только при реальной смене.
    val spec = width to gravity
    if (spec == sideNavScrimSpec) return
    sideNavScrimSpec = spec
    val scrim = sideNavScrim ?: View(this).apply {
      setBackgroundColor(SIDE_NAV_SCRIM_COLOR)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }.also {
      decor.addView(it, FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT))
      sideNavScrim = it
    }
    if (width <= 0) {
      scrim.visibility = View.GONE
      return
    }
    scrim.layoutParams = FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT, gravity)
    scrim.visibility = View.VISIBLE
  }

  private var lastKnownOrientation = Configuration.ORIENTATION_UNDEFINED

  override fun onConfigurationChanged(newConfig: Configuration) {
    // До super: сообщаем JS о повороте раньше, чем RN начнёт пересобирать раскладку.
    if (newConfig.orientation != lastKnownOrientation) {
      lastKnownOrientation = newConfig.orientation
      LiviAppModule.emitOrientationWillChange(
        newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE,
      )
    }
    super.onConfigurationChanged(newConfig)
    // Samsung и некоторые другие OEM после смены ориентации заново применяют
    // системные insets и могут вернуть непрозрачную боковую navigation bar.
    EdgeToEdgeHelper.apply(this)
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

  /**
   * Окно PiP закрыли (X / смахнули): система сразу останавливает активити, onResume не будет.
   * Завершаем звонок сразу, не дожидаясь pipExitDecideMs, — иначе у собеседника звонок
   * висит ещё ~2.5 с. Таймер остаётся запасным путём для OEM, где onStop не приходит.
   */
  private fun emitEndCallFromPiPDismissed(source: String) {
    if (!exitedPipPending || expandedEmittedForPipExit) return
    exitedPipPending = false
    wasInPip = false
    exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
    exitPipTimeoutRunnable = null
    android.util.Log.i("MainActivity", "PiP exit: dismissed ($source) -> emitting EndCallFromPiP")
    LiviAppModule.emitEndCallFromPiP()
  }

  /** Закрыть системный PiP при пуше call_ended (endedFromActive): собеседник в PiP не получает call:ended по сокету — пуш доходит, закрываем окно сразу. */
  private var closePipCallEndedReceiver: BroadcastReceiver? = null
  /** Forwards system Back into React Native (JS BackHandler). */
  private var reactBackCallback: OnBackPressedCallback? = null
  /** Был intent с EXTRA_PENDING_ANSWER_* — в onResume шлём LiviPendingAnswerCall (один раз на доставку). */
  private var pendingAnswerFromIntent = false
  /** Был ACTION_SEND — в onResume шлём LiviPendingShare. */
  private var pendingShareFromIntent = false
  private var lastFinishRequestAtMs = 0L
  private val pipEnterHandler = Handler(Looper.getMainLooper())
  private val pendingPiPEnterRunnables = mutableListOf<Runnable>()
  private var lastPiPEnterRequestAtMs = 0L
  private var isPiPEnterAttemptRunning = false

  /**
   * Идёт ли прямо сейчас попытка входа в system PiP.
   * Нужен выходу из PiP: ретраить «ещё не в PiP» осмысленно только пока вход в полёте.
   */
  fun isSystemPiPEnterInFlight(): Boolean = isPiPEnterAttemptRunning
  /** Runnable из onUserLeaveHint — повторный enter после setSystemPiPCaptureFrameReady(true) из JS. */
  private var leaveHintPiPEnterRunnable: Runnable? = null
  /** Анти-реэнтри: сразу после выхода из system PiP игнорируем ложный onUserLeaveHint этого же transition. */
  private var suppressPiPReenterUntilMs = 0L
  /** Системный PiP по leaveHint, но не пока открыты «Недавние». */
  private var suppressSystemPiPOnLeaveHintUntilMs = 0L
  /** Пользователь в overview Recents — PiP только после ухода в другое приложение / на Home (onStop). */
  private var inRecentsOverview = false
  /** Отложенный вход после leaveHint — ждём recentapps (гонка leaveHint ↔ broadcast на OEM). */
  private var deferredLeaveHintPiPRunnable: Runnable? = null
  private var homeKeyForPiPReceiver: BroadcastReceiver? = null
  private var clearRecentsSuppressRunnable: Runnable? = null
  /** Корреляция одного нажатия Home → system PiP (logcat SysPiPHome). */
  private var currentHomePiPTraceId: String = ""
  private var homePiPEnterAttemptSeq: Int = 0
  /** Нативная заглушка LiVi поверх RN — единый кадр system PiP на всех устройствах. */
  private var systemPiPBackdrop: View? = null
  /**
   * Крышка accept: тот же фон, что у audio VideoCall и Incoming после «Принять» (HOME_NAV_BG).
   * Нужна при подъёме Main раньше JS ConnectingCover.
   */
  private var incomingAnswerCoverView: View? = null

  fun showIncomingAnswerCover() {
    try {
      armIncomingAnswerCover = true
      val decor = window?.decorView as? ViewGroup ?: return
      val cover = incomingAnswerCoverView ?: run {
        val frame = android.widget.FrameLayout(this).apply {
          setBackgroundColor(getColor(R.color.home_nav_background))
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        decor.addView(
          frame,
          ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
          ),
        )
        frame.elevation = 20000f
        frame.translationZ = 20000f
        incomingAnswerCoverView = frame
        frame
      }
      cover.visibility = View.VISIBLE
      cover.bringToFront()
      decor.requestLayout()
      try {
        overridePendingTransition(0, 0)
      } catch (_: Exception) {}
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "showIncomingAnswerCover failed", e)
    }
  }

  fun hideIncomingAnswerCover() {
    try {
      armIncomingAnswerCover = false
      incomingAnswerCoverView?.visibility = View.GONE
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "hideIncomingAnswerCover failed", e)
    }
  }

  /**
   * Крышка «Поделиться»: экран отправки появляется только после onResume → JS, а до него
   * в окне виден прошлый экран приложения. Закрываем его фоном (HOME_NAV_BG), пока JS не
   * покажет экран отправки (hideShareCover), но не дольше SHARE_COVER_MAX_MS.
   */
  private var shareCoverView: View? = null
  private val shareCoverHandler = Handler(Looper.getMainLooper())
  private val hideShareCoverRunnable = Runnable { hideShareCover() }

  /**
   * Снимаем крышку, как только экран отправки (nativeID в IncomingSharePickerModal) создан и
   * отрисован, — не дожидаясь JS: после возврата из фона он ещё секунды занят перерисовками.
   */
  private val shareRootListener = object : ReactFindViewUtil.OnViewFoundListener {
    override fun getNativeId(): String = SHARE_ROOT_NATIVE_ID
    override fun onViewFound(view: View) {
      hideShareCoverWhenDrawn(view, 0, 0)
    }
  }

  private fun hideShareCoverWhenDrawn(view: View, readyFrames: Int, waited: Int) {
    if (shareCoverView?.visibility != View.VISIBLE) return
    android.view.Choreographer.getInstance().postFrameCallback {
      val ready = view.isAttachedToWindow && view.isShown && view.width > 0 && view.height > 0
      val nextReady = if (ready) readyFrames + 1 else 0
      // Два кадра подряд на экране: экран отправки уже нарисован под крышкой.
      if (nextReady >= 2) {
        hideShareCover()
      } else if (waited < 150) {
        hideShareCoverWhenDrawn(view, nextReady, waited + 1)
      }
    }
  }

  private fun showShareCover() {
    try {
      val decor = window?.decorView as? ViewGroup ?: return
      val cover = shareCoverView ?: run {
        val frame = android.widget.FrameLayout(this).apply {
          setBackgroundColor(getColor(R.color.home_nav_background))
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
          // Касания под крышкой не должны доходить до прошлого экрана.
          isClickable = true
        }
        decor.addView(
          frame,
          ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
          ),
        )
        frame.elevation = 20000f
        frame.translationZ = 20000f
        shareCoverView = frame
        frame
      }
      cover.visibility = View.VISIBLE
      cover.bringToFront()
      shareCoverHandler.removeCallbacks(hideShareCoverRunnable)
      shareCoverHandler.postDelayed(hideShareCoverRunnable, SHARE_COVER_MAX_MS)
      ReactFindViewUtil.removeViewListener(shareRootListener)
      // Экран отправки уже открыт (повторный «Поделиться») — нового nativeID не будет.
      val existing = ReactFindViewUtil.findView(decor, SHARE_ROOT_NATIVE_ID)
      if (existing != null) {
        hideShareCoverWhenDrawn(existing, 0, 0)
      } else {
        ReactFindViewUtil.addViewListener(shareRootListener)
      }
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "showShareCover failed", e)
    }
  }

  fun hideShareCover() {
    try {
      shareCoverHandler.removeCallbacks(hideShareCoverRunnable)
      ReactFindViewUtil.removeViewListener(shareRootListener)
      shareCoverView?.visibility = View.GONE
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "hideShareCover failed", e)
    }
  }

  private fun maybeShowIncomingAnswerCoverFromIntent(intent: Intent?) {
    val fromExtra = intent?.getBooleanExtra(EXTRA_INCOMING_ANSWER_COVER, false) == true
    // Не использовать hasPendingAnswerCall(): pending живёт до getAndClear и при каждом
    // bringMain/onNewIntent снова накрывал бы VideoCall чёрной крышкой после accept.
    if (fromExtra || armIncomingAnswerCover) {
      if (fromExtra) {
        try { intent?.removeExtra(EXTRA_INCOMING_ANSWER_COVER) } catch (_: Exception) {}
      }
      showIncomingAnswerCover()
    }
  }

  private fun showSystemPiPBackdropForCapture() {
    try {
      val decor = window?.decorView as? ViewGroup ?: return
      val backdrop = systemPiPBackdrop ?: run {
        val inflated = layoutInflater.inflate(R.layout.system_pip_backdrop, decor, false)
        decor.addView(
          inflated,
          ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
          ),
        )
        inflated.elevation = 10000f
        inflated.translationZ = 10000f
        systemPiPBackdrop = inflated
        inflated
      }
      backdrop.visibility = View.VISIBLE
      backdrop.bringToFront()
      decor.requestLayout()
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "showSystemPiPBackdropForCapture failed", e)
    }
  }

  /** Called from LiviAppModule when JS flips placeholderOnly while already in PiP. */
  internal fun applySystemPiPPlaceholderOnlyUi(placeholderOnly: Boolean) {
    try {
      if (!isInPictureInPictureMode && !isPiPEnterAttemptRunning) {
        if (!placeholderOnly) hideSystemPiPBackdropForCapture()
        return
      }
      if (placeholderOnly) {
        showSystemPiPBackdropForCapture()
      } else if (!LiviAppModule.getSystemPiPCaptureFrameReady()) {
        // Пока clean video-only слой не готов, держим native backdrop поверх RN.
        // Так даже fallback-вход никогда не захватит кнопки полноэкранного звонка.
        showSystemPiPBackdropForCapture()
      } else {
        hideSystemPiPBackdropForCapture()
      }
    } catch (_: Exception) {}
  }

  private fun restoreMainWindowBackgroundAfterPiP() {
    try {
      // Та же сцена, что в JS: без фона окна при повороте в полосах, которые RN
      // ещё не перерисовал, был бы чёрный.
      window.setBackgroundDrawable(StageBackgroundDrawable(this, StagePalette.TEAL_DEEP))
    } catch (_: Exception) {
      try {
        window.decorView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
      } catch (_: Exception) {}
    }
  }

  private fun hideSystemPiPBackdropForCapture() {
    try {
      systemPiPBackdrop?.visibility = View.GONE
      if (!isInPictureInPictureMode) {
        restoreMainWindowBackgroundAfterPiP()
      }
    } catch (_: Exception) {}
  }

  private fun homePiPTrace(phase: String, extras: Bundle.() -> Unit = {}) {
    try {
      if (currentHomePiPTraceId.isBlank()) {
        currentHomePiPTraceId = "hp_${System.currentTimeMillis()}"
      }
      val b = Bundle()
      extras.invoke(b)
      LiviAppModule.emitSystemPiPHomeTrace(currentHomePiPTraceId, phase, b)
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "homePiPTrace failed phase=$phase", e)
    }
  }

  private fun requestFinish(reason: String) {
    val now = System.currentTimeMillis()
    if (isFinishing || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed)) {
      android.util.Log.i("MainActivity", "requestFinish ignored ($reason): already finishing/destroyed")
      return
    }
    if (now - lastFinishRequestAtMs < 700L) {
      android.util.Log.i("MainActivity", "requestFinish deduped ($reason): duplicate within guard window")
      return
    }
    lastFinishRequestAtMs = now
    android.util.Log.i("MainActivity", "requestFinish accepted ($reason)")
    finish()
  }

  internal fun buildSystemPiPActions(): List<RemoteAction> = emptyList()

  private fun cancelPendingPiPEnterAttempts() {
    deferredLeaveHintPiPRunnable?.let { pipEnterHandler.removeCallbacks(it) }
    deferredLeaveHintPiPRunnable = null
    for (r in pendingPiPEnterRunnables) {
      pipEnterHandler.removeCallbacks(r)
    }
    pendingPiPEnterRunnables.clear()
    isPiPEnterAttemptRunning = false
    leaveHintPiPEnterRunnable = null
    if (!isInPictureInPictureMode) {
      hideSystemPiPBackdropForCapture()
    }
  }

  private fun markRecentsOverviewActive(source: String) {
    inRecentsOverview = true
    // Sticky до onResume (вернулись в LiVi) или onStop (ушли в другое приложение / Home).
    suppressSystemPiPOnLeaveHintUntilMs = Long.MAX_VALUE / 4
    clearRecentsSuppressRunnable?.let { pipHandler.removeCallbacks(it) }
    clearRecentsSuppressRunnable = null
    cancelPendingPiPEnterAttempts()
    try {
      syncSystemPiPAutoEnterParams(false)
    } catch (_: Exception) {}
    android.util.Log.i("MainActivity", "Recents overview active ($source) — system PiP suppressed")
    homePiPTrace("native_recents_overview") { putString("source", source) }
  }

  private fun clearRecentsOverviewFlag(source: String) {
    if (!inRecentsOverview && suppressSystemPiPOnLeaveHintUntilMs == 0L) return
    inRecentsOverview = false
    suppressSystemPiPOnLeaveHintUntilMs = 0L
    clearRecentsSuppressRunnable?.let { pipHandler.removeCallbacks(it) }
    clearRecentsSuppressRunnable = null
    android.util.Log.i("MainActivity", "Recents overview cleared ($source)")
  }

  private fun shouldArmSystemPiPEnter(): Boolean {
    if (LiviAppModule.getEndingCallInProgress()) return false
    return LiviAppModule.getShouldEnterPiPOnLeaveHint() ||
      LiviAppModule.isActiveCallForegroundRunning()
  }

  /**
   * Общий вход в system PiP:
   * - Home leaveHint после окна детекта Recents
   * - onStop после Recents → другое приложение / лаунчер
   */
  private fun beginSystemPiPEnterSequence(reason: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (isFinishing || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed)) return
    if (isInPictureInPictureMode) return
    if (inRecentsOverview) {
      android.util.Log.i("MainActivity", "beginSystemPiPEnterSequence skip — still in Recents ($reason)")
      homePiPTrace("native_skip") { putString("reason", "still_in_recents"); putString("enterReason", reason) }
      return
    }
    val now = System.currentTimeMillis()
    if (now < suppressPiPReenterUntilMs) {
      android.util.Log.i("MainActivity", "beginSystemPiPEnterSequence skip — pip exit cooldown ($reason)")
      return
    }
    if (!shouldArmSystemPiPEnter()) {
      android.util.Log.i("MainActivity", "beginSystemPiPEnterSequence skip — not armed ($reason)")
      return
    }
    if (isPiPEnterAttemptRunning && now - lastPiPEnterRequestAtMs < PIP_ENTER_DEDUP_MS) {
      android.util.Log.i("MainActivity", "beginSystemPiPEnterSequence skip — duplicate ($reason)")
      return
    }
    lastPiPEnterRequestAtMs = now
    cancelPendingPiPEnterAttempts()
    isPiPEnterAttemptRunning = true
    val placeholderOnlyEnter = LiviAppModule.getSystemPiPCapturePlaceholderOnly()
    val inAppPiPVisible = LiviAppModule.getInAppPiPVisibleForSystemPiP()
    if (placeholderOnlyEnter) {
      LiviAppModule.setSystemPiPCaptureFrameReadyStatic(true)
    }
    // Backdrop раньше показывался только внутри tryEnterPiP — к этому моменту auto-enter уже
    // мог быть armed без защиты кадра. Показываем сразу, как и в onUserLeaveHint, и по той же
    // причине передаём backdropAlreadyShown=true — иначе этот вызов гасит allow, выставленный
    // чуть раньше в onUserLeaveHint, откатывая единственный надёжный путь на строгих устройствах.
    showSystemPiPBackdropForCapture()
    syncSystemPiPAutoEnterParams(true)
    android.util.Log.i(
      "MainActivity",
      "beginSystemPiPEnterSequence reason=$reason placeholderOnly=$placeholderOnlyEnter inAppPiPVisible=$inAppPiPVisible",
    )
    val root = window?.decorView
    val decorW = root?.width ?: 0
    val decorH = root?.height ?: 0
    val tryEnterPiP = Runnable {
      try {
        if (isInPictureInPictureMode) return@Runnable
        if (inRecentsOverview) {
          android.util.Log.i("MainActivity", "tryEnterPiP abort — Recents overview ($reason)")
          cancelPendingPiPEnterAttempts()
          return@Runnable
        }
        // Late retry only: Home/homekey often still has focus on the first enter attempt.
        // Aborting immediately blocked system PiP on some OEMs. After ~350ms, foreground+focus
        // means the user already came back — cancel stale retries (pairs with onResume cancel).
        val waitedMsEarly = System.currentTimeMillis() - lastPiPEnterRequestAtMs
        val hasFocusNow = window?.decorView?.hasWindowFocus() == true
        if (
          waitedMsEarly >= PIP_ENTER_FOREGROUND_ABORT_AFTER_MS &&
          isInForeground &&
          hasFocusNow &&
          !exitedPipPending
        ) {
          android.util.Log.i(
            "MainActivity",
            "tryEnterPiP abort — stale retry, app foreground+focused (waitedMs=$waitedMsEarly reason=$reason)",
          )
          cancelPendingPiPEnterAttempts()
          return@Runnable
        }
        if (LiviAppModule.getEndingCallInProgress()) return@Runnable
        if (!LiviAppModule.getShouldEnterPiPOnLeaveHint()) {
          val fgsCall = LiviAppModule.isActiveCallForegroundRunning()
          if (!fgsCall || LiviAppModule.getEndingCallInProgress()) {
            android.util.Log.i("MainActivity", "tryEnterPiP skip — shouldEnterPiPOnLeaveHint=false")
            cancelPendingPiPEnterAttempts()
            return@Runnable
          }
        }
        val waitedMs = waitedMsEarly
        val placeholderOnly = LiviAppModule.getSystemPiPCapturePlaceholderOnly()
        val frameReady = LiviAppModule.getSystemPiPCaptureFrameReady()
        // Важно: enterPictureInPictureMode почти всегда нужно вызвать близко к leave/stop.
        if (!placeholderOnly && !frameReady && waitedMs < VIDEO_FRAME_GRACE_MS) {
          android.util.Log.d(
            "MainActivity",
            "tryEnterPiP brief defer for JS/video arm (waitedMs=$waitedMs reason=$reason)",
          )
          return@Runnable
        }
        if (!placeholderOnly && !frameReady && waitedMs >= VIDEO_FRAME_GRACE_MS) {
          android.util.Log.w(
            "MainActivity",
            "tryEnterPiP enter video PiP with protective backdrop (waitedMs=$waitedMs reason=$reason)",
          )
          homePiPTrace("native_enter_with_backdrop") {
            putLong("waitedMs", waitedMs)
            putString("enterReason", reason)
          }
        }
        if (placeholderOnly || !frameReady) {
          showSystemPiPBackdropForCapture()
        } else {
          hideSystemPiPBackdropForCapture()
        }
        val ratio = if (placeholderOnly) Rational(16, 9) else Rational(9, 16)
        val builder =
          PictureInPictureParams.Builder()
            .setAspectRatio(ratio)
            .setActions(buildSystemPiPActions())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          builder.setAutoEnterEnabled(true)
        }
        val liveSourceRect = buildSystemPiPSourceRect(placeholderOnly)
        if (liveSourceRect != null) {
          builder.setSourceRectHint(liveSourceRect)
        }
        val params = builder.build()
        if (enterPictureInPictureMode(params)) {
          android.util.Log.d("MainActivity", "Entered Picture-in-Picture mode ($reason)")
          homePiPTrace("native_enter_pip_ok") {
            putBoolean("placeholderOnly", placeholderOnly)
            putString("enterReason", reason)
          }
          cancelPendingPiPEnterAttempts()
        } else {
          android.util.Log.w("MainActivity", "enterPictureInPictureMode returned false ($reason)")
          homePiPTrace("native_enter_pip_false") {
            putBoolean("placeholderOnly", placeholderOnly)
            putString("enterReason", reason)
          }
          if (!isInPictureInPictureMode) {
            hideSystemPiPBackdropForCapture()
          }
        }
      } catch (e2: Exception) {
        android.util.Log.w("MainActivity", "enterPictureInPictureMode failed ($reason)", e2)
        homePiPTrace("native_enter_pip_error") {
          putString("error", e2.message ?: "unknown")
          putString("enterReason", reason)
        }
      }
    }
    leaveHintPiPEnterRunnable = tryEnterPiP
    try {
      LiviAppModule.emitAboutToEnterSystemPiP(decorW, decorH, currentHomePiPTraceId)
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "emitAboutToEnterSystemPiP failed ($reason)", e)
      cancelPendingPiPEnterAttempts()
      homePiPTrace("native_skip") { putString("reason", "emit_about_to_enter_failed") }
      return
    }
    if (!isInPictureInPictureMode) {
      val canEnterNow =
        placeholderOnlyEnter || LiviAppModule.getSystemPiPCaptureFrameReady()
      pendingPiPEnterRunnables.add(tryEnterPiP)
      if (canEnterNow) {
        tryEnterPiP.run()
      }
      if (!isInPictureInPictureMode) {
        pipEnterHandler.post(tryEnterPiP)
        android.util.Log.i(
          "MainActivity",
          "scheduled PiP enter retries reason=$reason placeholderOnlyStart=$placeholderOnlyEnter frameReady=${LiviAppModule.getSystemPiPCaptureFrameReady()}",
        )
        for (d in PIP_ENTER_RETRY_DELAYS_MS) {
          val r = Runnable { tryEnterPiP.run() }
          pendingPiPEnterRunnables.add(r)
          pipEnterHandler.postDelayed(r, d)
        }
        val requestToken = lastPiPEnterRequestAtMs
        val giveUpDelay = (PIP_ENTER_RETRY_DELAYS_MS.maxOrNull() ?: 0L) + PIP_ENTER_GIVE_UP_BUFFER_MS
        val giveUp = Runnable {
          if (
            !isInPictureInPictureMode &&
            isPiPEnterAttemptRunning &&
            lastPiPEnterRequestAtMs == requestToken
          ) {
            android.util.Log.i(
              "MainActivity",
              "beginSystemPiPEnterSequence give up — retries exhausted ($reason)",
            )
            homePiPTrace("native_enter_give_up") { putString("enterReason", reason) }
            cancelPendingPiPEnterAttempts()
          }
        }
        pendingPiPEnterRunnables.add(giveUp)
        pipEnterHandler.postDelayed(giveUp, giveUpDelay)
      }
    }
  }

  /** После явного возврата на VideoCall (тап PiP / уведомление) — снова разрешить Home → system PiP. */
  internal fun clearSuppressPiPReenterCooldown() {
    suppressPiPReenterUntilMs = 0L
  }

  /** LiviAppModule при setEndingCallInProgress(true) — отменить отложенный вход в PiP после goBack. */
  internal fun cancelPendingPiPEnterAttemptsForCallTeardown() {
    cancelPendingPiPEnterAttempts()
    // Звонок завершается — жёстко убираем нативную PiP-заглушку из иерархии, а не только
    // прячем (GONE). Иначе при завершении из in-app PiP / в гонке тёмный фон может залипнуть.
    if (!isInPictureInPictureMode) {
      forceRemoveSystemPiPBackdropForTeardown()
    }
  }

  /** Полностью удалить нативную PiP-заглушку из иерархии (на call teardown), чтобы не залипала. */
  private fun forceRemoveSystemPiPBackdropForTeardown() {
    try {
      systemPiPBackdrop?.let { v ->
        (v.parent as? ViewGroup)?.removeView(v)
      }
      systemPiPBackdrop = null
      restoreMainWindowBackgroundAfterPiP()
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "forceRemoveSystemPiPBackdropForTeardown failed", e)
    }
  }

  /** JS отрисовал SystemPiPCaptureHost — повторить enter, пока окно leaveHint ещё активно. */
  internal fun retryEnterSystemPiPIfLeaveHintPending() {
    if (!isPiPEnterAttemptRunning || isInPictureInPictureMode) return
    val r = leaveHintPiPEnterRunnable ?: return
    pipEnterHandler.post(r)
  }

  /**
   * Android 12+: auto-enter только на время явного beginSystemPiPEnterSequence.
   * Иначе Recents/overview сам уводит в PiP (пустое «Нет открытых приложений»).
   */
  internal fun syncSystemPiPAutoEnterParams(enabled: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    try {
      if (isFinishing || isDestroyed) return
      // Раньше auto-enter включался только на время ручной попытки (isPiPEnterAttemptRunning),
      // поэтому системный вход в PiP фактически не использовался. Теперь разрешаем auto-enter
      // по armed-состоянию звонка — система сама надёжно вводит в PiP при уходе в фон (S+).
      val placeholderOnly = LiviAppModule.getSystemPiPCapturePlaceholderOnly()
      // ВАЖНО: auto-enter больше не ждёт frameReady/backdrop здесь. setPiPOnLeaveHintEnabled
      // вооружает этот флаг ПРОАКТИВНО, как только звонок становится PiP-eligible (задолго до
      // любого Home) — именно так и задуман setAutoEnterEnabled в системе. Гейт по frameReady
      // держал allow=false весь звонок (для видео он не готов синхронно почти никогда), из-за
      // чего auto-enter реально вооружался только реактивно внутри onUserLeaveHint — а на части
      // устройств/версий Android (напр. API 36) к этому моменту система уже не учитывает флаг
      // для текущего перехода: ручной enterPictureInPictureMode() там возвращает false/бросает
      // "Activity must be resumed", и БЕЗ заранее armed auto-enter Home просто сворачивает
      // приложение без всякого PiP. Защита от захваченного chrome теперь не здесь, а в
      // onPictureInPictureModeChanged(true) — backdrop остаётся/показывается там же, независимо
      // от того, кто вызвал вход (ручной путь или сама система).
      val allow =
        enabled &&
          !inRecentsOverview &&
          !LiviAppModule.getEndingCallInProgress() &&
          (LiviAppModule.getShouldEnterPiPOnLeaveHint() || LiviAppModule.isActiveCallForegroundRunning())
      val ratio = if (placeholderOnly) Rational(16, 9) else Rational(9, 16)
      val builder =
        PictureInPictureParams.Builder()
          .setAspectRatio(ratio)
          .setActions(buildSystemPiPActions())
          .setAutoEnterEnabled(allow)
      val sourceRect = buildSystemPiPSourceRect(placeholderOnly)
      if (sourceRect != null) {
        builder.setSourceRectHint(sourceRect)
      }
      setPictureInPictureParams(builder.build())
      android.util.Log.i(
        "MainActivity",
        "syncSystemPiPAutoEnterParams allow=$allow placeholderOnly=$placeholderOnly",
      )
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "syncSystemPiPAutoEnterParams failed", e)
    }
  }

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

  private fun tryStashShareFromIntent(i: Intent?): Boolean {
    if (i == null) return false
    if (!ShareIntentHandler.isShareIntent(i)) return false
    return try {
      ShareIntentHandler.stashFromIntent(applicationContext, i)
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "tryStashShareFromIntent failed", e)
      false
    }
  }

  private fun buildSystemPiPSourceRect(placeholderOnly: Boolean = true): Rect? {
    return try {
      val root = window?.decorView ?: return null
      val w = root.width
      val h = root.height
      if (w <= 0 || h <= 0) return null
      if (placeholderOnly) {
        return Rect(0, 0, w, h)
      }
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

  private fun handleLauncherTapDuringActiveCall(intent: Intent?) {
    if (!isLaunchedFromLauncher(intent)) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode) {
      emitSystemPiPExpandedOnce("launcher-tap-in-pip")
      return
    }
    if (LiviAppModule.getShouldEnterPiPOnLeaveHint() && !LiviAppModule.getEndingCallInProgress()) {
      android.util.Log.i("MainActivity", "launcher tap during active call -> pending return to VideoCall")
      LiviAppModule.setPendingReturnToActiveCall(this)
      return
    }
    if (LiviOngoingCallHelper.launchOngoingCallActivityIfNeeded(this)) {
      hideMainActivityForOngoingNativeCall()
    }
  }

  /**
   * Показать нативный экран звонка поверх задачи, но **не** finish() — иначе умирает React
   * и после таймаута/закрытия звонка процесс часто завершается (холодный старт с лаунчера).
   */
  private fun hideMainActivityForOngoingNativeCall() {
    if (isFinishing || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed)) {
      android.util.Log.i("MainActivity", "launcher-redirect-to-ongoing-call: skip (finishing)")
      return
    }
    android.util.Log.i("MainActivity", "launcher-redirect-to-ongoing-call: moveTaskToBack (keep MainActivity)")
    moveTaskToBack(true)
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
    // Тап по уведомлению в шторке → welcome Chat / Calls (не legacy friends menu).
    consumeShadeOpenIntent(intent, dismissMissed = true)
    handleReturnToActiveCallIntent(intent)
    handleAudioOnlyFromPiPIntent(intent)
    if (tryStashPendingAnswerFromIntent(intent)) {
      pendingAnswerFromIntent = true
      markIncomingCallOverLock()
    }
    if (tryStashShareFromIntent(intent)) {
      pendingShareFromIntent = true
      // Приложение уже открыто: до экрана отправки виден не прошлый экран, а фон.
      showShareCover()
      // Отдать JS сейчас, до onResume: иначе первым придёт AppState active, и экран
      // отправки встанет в очередь за перерисовками возврата из фона.
      if (LiviAppModule.emitPendingShareNow()) pendingShareFromIntent = false
    }
    maybeShowIncomingAnswerCoverFromIntent(intent)
    handleLauncherTapDuringActiveCall(intent)
  }

  private fun emitSystemPiPExpandedOnce(reason: String) {
    exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
    exitPipTimeoutRunnable = null
    exitedPipPending = false
    wasInPip = false
    expandedEmittedForPipExit = true
    LiviAppModule.setPiPOnLeaveHintEnabled(false)
    hideSystemPiPBackdropForCapture()
    android.util.Log.i("MainActivity", "PiP exit: $reason -> emitting SystemPiPExpanded")
    LiviAppModule.emitSystemPiPExpanded()
  }

  override fun onResume() {
    super.onResume()
    lastResumedInstance = this
    applyShowOverLock(shouldShowOverLock())
    isInForeground = true
    // Вернулись в приложение из Недавних — снова обычный режим (без sticky suppress).
    clearRecentsOverviewFlag("onResume")
    if (!isInPictureInPictureMode) {
      // Иначе delayed retry из leaveHint/Home может войти в PiP уже после возврата.
      cancelPendingPiPEnterAttempts()
      hideSystemPiPBackdropForCapture()
    }
    // Выход из системного PiP по кнопке «развернуть»: надёжно обрабатываем только тот resume,
    // который пришёл после onPictureInPictureModeChanged(false). Старый fallback по wasInPip
    // давал ложный SystemPiPExpanded во время Home -> system PiP на части устройств.
    if (exitedPipPending) {
      emitSystemPiPExpandedOnce("onResume")
    }
    restoreNavigationBarVisibility()
    // Тап по уведомлению в шторке → welcome Chat / Calls
    consumeShadeOpenIntent(intent, dismissMissed = true)
    handleReturnToActiveCallIntent(intent)
    handleAudioOnlyFromPiPIntent(intent)
    handleLauncherTapDuringActiveCall(intent)
    maybeShowIncomingAnswerCoverFromIntent(intent)
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
    if (pendingShareFromIntent && LiviAppModule.hasPendingShareItems()) {
      pendingShareFromIntent = false
      LiviAppModule.emitPendingShareEvent()
    }
    // S+: пока идёт звонок и Activity RESUMED — держим системный auto-enter взведённым,
    // чтобы уход в фон надёжно вводил в PiP на всех устройствах (без ручной гонки).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !isInPictureInPictureMode) {
      try {
        if (shouldArmSystemPiPEnter()) {
          syncSystemPiPAutoEnterParams(true)
        }
      } catch (_: Exception) {}
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // После ответа/отмены вызова из IncomingCallActivity на части устройств
    // пропадает кнопка «Недавние» (три полоски). Явно восстанавливаем отображение
    // системной навигационной панели при получении фокуса.
    if (hasFocus) {
      restoreNavigationBarVisibility()
      // restoreNavigationBarVisibility() показывает системные кнопки, после чего
      // ещё раз возвращаем прозрачные бары и layout под ними.
      EdgeToEdgeHelper.apply(this)
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
   * Уход из «Недавних» в другое приложение / на лаунчер → system PiP.
   * Само открытие Recents PiP не делает (см. onUserLeaveHint + recentapps).
   */
  override fun onStop() {
    val leftRecentsOverview = inRecentsOverview
    super.onStop()
    if (isChangingConfigurations) return
    // Остановка сразу после выхода из PiP без onResume — окно закрыли, а не развернули.
    if (exitedPipPending && !isInPictureInPictureMode) {
      emitEndCallFromPiPDismissed("onStop")
    }
    if (isFinishing) {
      clearRecentsOverviewFlag("onStop_finishing")
      cancelPendingPiPEnterAttempts()
      return
    }
    if (isInPictureInPictureMode) {
      clearRecentsOverviewFlag("onStop_already_pip")
      return
    }
    if (!leftRecentsOverview) return
    // Снимаем overview: иначе beginSystemPiPEnterSequence сразу выйдет.
    clearRecentsOverviewFlag("onStop_leave_recents")
    currentHomePiPTraceId = "hp_${System.currentTimeMillis()}"
    homePiPEnterAttemptSeq = 0
    homePiPTrace("native_on_stop_after_recents") {
      putBoolean("shouldEnterPiP", shouldArmSystemPiPEnter())
    }
    android.util.Log.i("MainActivity", "onStop after Recents — enter system PiP if call active")
    beginSystemPiPEnterSequence("onStop_after_recents")
  }

  /**
   * Home / уход в фон → system PiP.
   * Recents: leaveHint часто раньше broadcast — ждём RECENTS_DETECT_DELAY_MS;
   * если пришёл recentapps — вход отменяется, PiP только из onStop.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    // GSM/WA поверх видеозвонка: hold должен стартовать до/вместе с system PiP, иначе партнёр
    // видит только PiP без «Звонок на удержании».
    try {
      LiviAppModule.onActiveCallUserLeaveHintStatic(applicationContext)
    } catch (_: Exception) {}
    currentHomePiPTraceId = "hp_${System.currentTimeMillis()}"
    homePiPEnterAttemptSeq = 0
    val now = System.currentTimeMillis()
    // ВАЖНО: не глушим здесь S+ auto-enter. Раньше строка syncSystemPiPAutoEnterParams(false)
    // отключала системный вход, и приложение полагалось на отложенный (400мс) ручной
    // enterPictureInPictureMode(), который на части устройств (Samsung One UI) падал с
    // "Activity must be resumed to enter picture-in-picture" — Activity уже уходила в onStop.
    // Теперь на S+ системный auto-enter (взведённый заранее в onResume/arm) вводит в PiP сам.
    // Плата: PiP входит и при открытии «Недавних» — это стандартное поведение (как WhatsApp),
    // и приемлемо, т.к. требование — PiP обязан показываться при любом уходе в фон.
    if (inRecentsOverview || now < suppressSystemPiPOnLeaveHintUntilMs) {
      android.util.Log.i(
        "MainActivity",
        "onUserLeaveHint: skip system PiP — Recents overview (inOverview=$inRecentsOverview)",
      )
      cancelPendingPiPEnterAttempts()
      homePiPTrace("native_skip") { putString("reason", "recent_recents") }
      return
    }
    if (now < suppressPiPReenterUntilMs) {
      android.util.Log.i(
        "MainActivity",
        "onUserLeaveHint: skip system PiP due to recent PiP-exit cooldown (remainingMs=${suppressPiPReenterUntilMs - now})",
      )
      cancelPendingPiPEnterAttempts()
      homePiPTrace("native_skip") { putString("reason", "pip_exit_cooldown") }
      return
    }
    val endingCallInProgressEarly = LiviAppModule.getEndingCallInProgress()
    val shouldEnterPiPEarly = shouldArmSystemPiPEnter() && !endingCallInProgressEarly
    val placeholderOnlyEarly = LiviAppModule.getSystemPiPCapturePlaceholderOnly()
    val inAppPiPVisibleEarly = LiviAppModule.getInAppPiPVisibleForSystemPiP()
    homePiPTrace("native_on_user_leave_hint") {
      putBoolean("shouldEnterPiP", shouldEnterPiPEarly)
      putBoolean("placeholderOnly", placeholderOnlyEarly)
      putBoolean("endingCallInProgress", endingCallInProgressEarly)
      putBoolean("inAppPiPVisible", inAppPiPVisibleEarly)
      putBoolean("isInPiP", isInPictureInPictureMode)
      putBoolean("hasFocus", window?.decorView?.hasWindowFocus() == true)
      putInt("sdk", Build.VERSION.SDK_INT)
      putLong("recentsDetectDelayMs", RECENTS_DETECT_DELAY_MS)
    }
    if (endingCallInProgressEarly) {
      android.util.Log.i("MainActivity", "onUserLeaveHint: skip system PiP because endingCallInProgress=true")
      homePiPTrace("native_skip") { putString("reason", "ending_call") }
      return
    }
    android.util.Log.i(
      "MainActivity",
      "onUserLeaveHint: sdk=${Build.VERSION.SDK_INT} shouldEnterPiP=$shouldEnterPiPEarly inAppPiPVisible=$inAppPiPVisibleEarly isInPiP=$isInPictureInPictureMode — defer ${RECENTS_DETECT_DELAY_MS}ms for Recents detect",
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && shouldEnterPiPEarly) {
      val frameReadyEarly = LiviAppModule.getSystemPiPCaptureFrameReady()
      // Заглушка ДО входа всегда, а не только для placeholderOnly: чистый video-only кадр
      // не может стать готовым синхронно (JS не успевает отрисовать layout внутри
      // onUserLeaveHint) — backdrop, а не ожидание frameReady, гарантирует отсутствие
      // захваченных кнопок звонка в первом кадре PiP.
      if (placeholderOnlyEarly) {
        LiviAppModule.setSystemPiPCaptureFrameReadyStatic(true)
      }
      showSystemPiPBackdropForCapture()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // Заглушка выше уже защищает кадр (syncSystemPiPAutoEnterParams сам увидит её
        // видимость), поэтому системный auto-enter вооружается не дожидаясь frameReady —
        // единственный надёжный путь на устройствах/версиях Android, где ручной
        // enterPictureInPictureMode() ниже может отказать ("Activity must be resumed")
        // из-за более узкого resumed-окна.
        try { syncSystemPiPAutoEnterParams(true) } catch (_: Exception) {}
      }
      homePiPTrace("native_s_plus_auto_enter_arm") {
        putBoolean("placeholderOnly", placeholderOnlyEarly)
      }
      // КАНОНИЧНЫЙ путь: входим в PiP СИНХРОННО прямо здесь, пока Activity ещё RESUMED.
      // onUserLeaveHint — штатное место входа в PiP. Раньше вход откладывался на
      // RECENTS_DETECT_DELAY_MS(=400мс), из-за чего к моменту вызова Activity уже уходила в
      // onStop и enterPictureInPictureMode падал с "Activity must be resumed". Backdrop выше
      // уже защищает кадр, поэтому синхронная попытка не ждёт frameReady — иначе для видео
      // он никогда не готов синхронно и этот путь всегда пустой.
      var enteredSync = false
      if (!isInPictureInPictureMode) {
        try {
          val ratioSync = if (placeholderOnlyEarly) Rational(16, 9) else Rational(9, 16)
          val builderSync =
            PictureInPictureParams.Builder()
              .setAspectRatio(ratioSync)
              .setActions(buildSystemPiPActions())
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builderSync.setAutoEnterEnabled(true)
          }
          val srcSync = buildSystemPiPSourceRect(placeholderOnlyEarly)
          if (srcSync != null) builderSync.setSourceRectHint(srcSync)
          enteredSync = enterPictureInPictureMode(builderSync.build())
          homePiPTrace(if (enteredSync) "native_enter_pip_ok" else "native_enter_pip_false") {
            putString("enterReason", "leaveHint_sync")
            putBoolean("placeholderOnly", placeholderOnlyEarly)
          }
          android.util.Log.i(
            "MainActivity",
            "onUserLeaveHint sync enterPiP -> $enteredSync (placeholderOnly=$placeholderOnlyEarly frameReady=$frameReadyEarly)",
          )
        } catch (e: Exception) {
          android.util.Log.w("MainActivity", "onUserLeaveHint sync enter PiP failed", e)
          homePiPTrace("native_enter_pip_error") {
            putString("enterReason", "leaveHint_sync")
            putString("error", e.message ?: "unknown")
          }
        }
      }
      if (enteredSync || isInPictureInPictureMode) {
        // Уже вошли в PiP синхронно — отложенный ретрай не нужен (и не гасим заглушку).
        // Backdrop снимет сам JS через setSystemPiPCaptureFrameReady(true) после чистого onLayout.
        return
      }
      // Фолбэк: синхронный вход не удался (Android отказал/бросил) — прежний отложенный путь.
      deferredLeaveHintPiPRunnable?.let { pipEnterHandler.removeCallbacks(it) }
      val deferred =
        Runnable {
          deferredLeaveHintPiPRunnable = null
          if (inRecentsOverview || System.currentTimeMillis() < suppressSystemPiPOnLeaveHintUntilMs) {
            android.util.Log.i("MainActivity", "deferred leaveHint PiP cancelled — Recents overview")
            homePiPTrace("native_skip") { putString("reason", "deferred_recents") }
            return@Runnable
          }
          beginSystemPiPEnterSequence("leaveHint_after_recents_detect")
        }
      deferredLeaveHintPiPRunnable = deferred
      pipEnterHandler.postDelayed(deferred, RECENTS_DETECT_DELAY_MS)
    } else {
      android.util.Log.i(
        "MainActivity",
        "onUserLeaveHint: skip system PiP because shouldEnterPiPOnLeaveHint=false or sdk<26",
      )
      cancelPendingPiPEnterAttempts()
      homePiPTrace("native_skip") { putString("reason", "should_enter_false_or_sdk") }
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (isInPictureInPictureMode) {
        cancelPendingPiPEnterAttempts()
        val placeholderOnly = LiviAppModule.getSystemPiPCapturePlaceholderOnly()
        // Auto-enter теперь armed заранее и может сработать без чистого video-only кадра —
        // держим backdrop, пока JS не подтвердит frameReady, а не только для placeholderOnly.
        if (placeholderOnly || !LiviAppModule.getSystemPiPCaptureFrameReady()) {
          showSystemPiPBackdropForCapture()
          try {
            window.setBackgroundDrawableResource(R.color.system_pip_backdrop)
          } catch (_: Exception) {
            window.setBackgroundDrawableResource(android.R.color.black)
          }
        } else {
          hideSystemPiPBackdropForCapture()
          try {
            window.setBackgroundDrawableResource(android.R.color.black)
          } catch (_: Exception) {}
        }
        // Вход в PiP: отменяем таймер «выход из PiP», иначе на части устройств через таймаут срабатывает EndCallFromPiP.
        exitPipTimeoutRunnable?.let { pipHandler.removeCallbacks(it) }
        exitPipTimeoutRunnable = null
        exitedPipPending = false
        expandedEmittedForPipExit = false
        wasInPip = true
      }
      LiviAppModule.emitSystemPiPModeChanged(isInPictureInPictureMode)
      if (!isInPictureInPictureMode) {
        hideSystemPiPBackdropForCapture()
        // На части устройств сразу после разворота из PiP прилетает ложный onUserLeaveHint и
        // может повторно увести экран в PiP. Держим короткое окно anti re-enter.
        suppressPiPReenterUntilMs = System.currentTimeMillis() + 3000L
        // Сразу отключаем вход в PiP по onUserLeaveHint — на части устройств onUserLeaveHint
        // приходит во время перехода PiP→fullscreen до onResume; иначе приложение снова уходит в PiP.
        LiviAppModule.setPiPOnLeaveHintEnabled(false)
        try {
          syncSystemPiPAutoEnterParams(false)
        } catch (_: Exception) {}
        pipHandler.postDelayed({
          try {
            if (isInPictureInPictureMode || LiviAppModule.getEndingCallInProgress()) return@postDelayed
            if (LiviAppModule.isActiveCallForegroundRunning()) {
              LiviAppModule.setPiPOnLeaveHintEnabled(true)
              // Не форсируем logo: иначе следующий Home/Back входит в лого до AboutToEnter,
              // даже когда peer/local cam уже on. JS sync держит placeholder truth.
              syncSystemPiPAutoEnterParams(true)
            }
          } catch (_: Exception) {}
        }, 3200L)
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
        // onStop мог прийти раньше этого колбэка (так на One UI): активити уже остановлена.
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
          emitEndCallFromPiPDismissed("modeChanged(false)+stopped")
        }
        val hasFocus = window?.decorView?.hasWindowFocus() == true
        if (isInForeground && hasFocus && !isPiPEnterAttemptRunning) {
          emitSystemPiPExpandedOnce("modeChanged(false)+foreground")
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Phones: portrait; tablets: any orientation (avoids letterbox when tablet is landscape).
    ScreenOrientationHelper.applyPhonePortraitTabletAny(this)
    // При запуске по livi://decline-call — прозрачная тема: пользователь видит экран блокировки/лаунчер, не страницу приветствия.
    if (isDeclineCallIntent(intent)) {
      setTheme(R.style.Theme_App_Translucent)
    } else {
      setTheme(R.style.AppTheme)
    }
    super.onCreate(null)
    if (!isDeclineCallIntent(intent)) {
      // Новая сцена, как у JS-сплэша, пиксель-в-пиксель: старт без смены тона.
      window.setBackgroundDrawable(StageBackgroundDrawable(this, StagePalette.TEAL_DEEP))
    }
    liveInstance = this
    applyShowOverLock(shouldShowOverLock())
    // targetSdk 36: edge-to-edge is enforced; RN SafeAreaProvider pads content.
    EdgeToEdgeHelper.apply(this)
    observeImeInsets()
    registerHomeKeyForSystemPiPReceiver()
    // targetSdk 36 / predictive back: dispatcher can finish the Activity without ever calling
    // ReactActivity.onBackPressed() → JS BackHandler never runs → app minimizes/closes.
    // Forward Back into RN explicitly; do not re-dispatch via onBackPressedDispatcher.
    if (reactBackCallback == null) {
      reactBackCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          android.util.Log.i(
            "MainActivity",
            "System back → React Native BackHandler; isInPiP=$isInPictureInPictureMode",
          )
          // ReactActivity.onBackPressed → DeviceEventManagerModule.emitHardwareBackPressed.
          // Returns without super when RN is alive; JS may later call invokeDefaultOnBackPressed.
          @Suppress("DEPRECATION")
          onBackPressed()
        }
      }
      onBackPressedDispatcher.addCallback(this, reactBackCallback!!)
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
    // Тап по уведомлению в шторке: флаг для JS (снятие missed — в onResume).
    consumeShadeOpenIntent(intent, dismissMissed = false)
    handleReturnToActiveCallIntent(intent)
    handleAudioOnlyFromPiPIntent(intent)
    if (tryStashPendingAnswerFromIntent(intent)) {
      pendingAnswerFromIntent = true
      markIncomingCallOverLock()
    }
    if (tryStashShareFromIntent(intent)) {
      pendingShareFromIntent = true
    }
    maybeShowIncomingAnswerCoverFromIntent(intent)
    handleLauncherTapDuringActiveCall(intent)
    // Пуш call_ended (endedFromActive): закрыть PiP + JS teardown (сокет в фоне часто без call:ended).
    // Не softExit (разворот в fullscreen) — иначе у peer звонок «висит» в UI.
    closePipCallEndedReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != LiviFirebaseMessagingService.ACTION_CLOSE_PIP_CALL_ENDED) return
        val callId = intent.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID)
        (context as? MainActivity)?.runOnUiThread {
          val self = context as? MainActivity ?: return@runOnUiThread
          LiviAppModule.setEndingCallInProgressStatic(true)
          LiviAppModule.setPiPOnLeaveHintEnabled(false)
          LiviAppModule.emitRemoteCallEndedInSystemPiP(callId)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && self.isInPictureInPictureMode) {
            try {
              // Cancel expand-vs-X timer: remote end must not become SystemPiPExpanded.
              self.exitPipTimeoutRunnable?.let { self.pipHandler.removeCallbacks(it) }
              self.exitPipTimeoutRunnable = null
              self.exitedPipPending = false
              self.expandedEmittedForPipExit = true
              LiviAppModule.hardExitFromSystemPiPNoDebounce(self)
            } catch (e: Exception) {
              android.util.Log.w("MainActivity", "hardExitFromSystemPiPNoDebounce failed, fallback requestFinish", e)
              self.requestFinish("close-pip-from-call-ended-push")
            }
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

  private fun registerHomeKeyForSystemPiPReceiver() {
    if (homeKeyForPiPReceiver != null) return
    homeKeyForPiPReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != Intent.ACTION_CLOSE_SYSTEM_DIALOGS) return
        when (intent.getStringExtra("reason")) {
          "homekey" -> {
            // Home подтверждён системой — не ждать RECENTS_DETECT_DELAY_MS для уже
            // запланированного фолбэка из onUserLeaveHint. Не стартуем здесь отдельную
            // beginSystemPiPEnterSequence: ACTION_CLOSE_SYSTEM_DIALOGS — необязательный
            // broadcast (на части OEM/версий Android не доставляется вовсе, на других
            // приходит с опозданием) и своя независимая попытка входа гонялась с уже
            // запущенным официальным путём onUserLeaveHint — это и давало device-specific
            // разброс (двойной вход/флик на одних устройствах, тишина на других).
            clearRecentsOverviewFlag("homekey")
            deferredLeaveHintPiPRunnable?.let {
              pipEnterHandler.removeCallbacks(it)
              deferredLeaveHintPiPRunnable = null
              it.run()
            }
          }
          "recentapps" -> {
            markRecentsOverviewActive("recentapps")
          }
        }
      }
    }
    val filter = IntentFilter(Intent.ACTION_CLOSE_SYSTEM_DIALOGS)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(homeKeyForPiPReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      registerReceiver(homeKeyForPiPReceiver, filter)
    }
  }

  private fun applyShowOverLock(show: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(show)
      setTurnScreenOn(show)
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (show) window.addFlags(flags) else window.clearFlags(flags)
    }
  }

  override fun onDestroy() {
    if (liveInstance === this) {
      liveInstance = null
    }
    if (lastResumedInstance === this) {
      lastResumedInstance = null
    }
    cancelPendingPiPEnterAttempts()
    clearRecentsSuppressRunnable?.let { pipHandler.removeCallbacks(it) }
    clearRecentsSuppressRunnable = null
    inRecentsOverview = false
    suppressSystemPiPOnLeaveHintUntilMs = 0L
    homeKeyForPiPReceiver?.let {
      try { unregisterReceiver(it) } catch (_: Exception) {}
      homeKeyForPiPReceiver = null
    }
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
    * Align root Back across API levels: always move task to background instead of finish().
    * During an active call, enter system PiP the same way as Home (onUserLeaveHint path).
    * Rapid Back presses must keep minimizing, never kill the task root.
    */
  override fun invokeDefaultOnBackPressed() {
      if (!isTaskRoot) {
          super.invokeDefaultOnBackPressed()
          return
      }
      val ending = LiviAppModule.getEndingCallInProgress()
      val wantSystemPiP =
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
              !isInPictureInPictureMode &&
              !ending &&
              (LiviAppModule.getShouldEnterPiPOnLeaveHint() || LiviAppModule.isActiveCallForegroundRunning())
      if (wantSystemPiP) {
          // Same enter sequence as Home; moveTaskToBack alone is not enough on all OEMs.
          try {
              onUserLeaveHint()
          } catch (_: Exception) {
          }
          if (!isInPictureInPictureMode) {
              try {
                  retryEnterSystemPiPIfLeaveHintPending()
              } catch (_: Exception) {
              }
          }
      }
      try {
          if (!isInPictureInPictureMode) {
              // Отложить фон на кадр — дать enter из leave-hint/retry завершиться.
              window?.decorView?.post {
                  try {
                      if (!isInPictureInPictureMode) {
                          retryEnterSystemPiPIfLeaveHintPending()
                      }
                      if (!isInPictureInPictureMode) {
                          moveTaskToBack(true)
                      }
                  } catch (_: Exception) {
                      try {
                          moveTaskToBack(true)
                      } catch (_: Exception) {
                      }
                  }
              } ?: moveTaskToBack(true)
          }
      } catch (_: Exception) {
          // Never finish() the root task — user expects Back to background the app.
      }
  }

  /**
   * Тап по shade: непрочитанные → welcome Chat; пропущенные → welcome Calls.
   * Action и extra разделены — иначе общий PendingIntent requestCode=0 склеивал оба типа.
   */
  private fun consumeShadeOpenIntent(intent: Intent?, dismissMissed: Boolean) {
    if (intent == null) return
    val action = intent.action
    val openChat =
      action == LiviFirebaseMessagingService.ACTION_OPEN_UNREAD_CHAT ||
        intent.getBooleanExtra(EXTRA_OPEN_WELCOME_CHAT, false)
    val openCalls =
      action == LiviFirebaseMessagingService.ACTION_OPEN_MISSED_CALLS ||
        intent.getBooleanExtra(EXTRA_OPEN_TAB_FRIENDS, false)
    if (openChat) {
      intent.removeExtra(EXTRA_OPEN_WELCOME_CHAT)
      if (action == LiviFirebaseMessagingService.ACTION_OPEN_UNREAD_CHAT) {
        intent.action = null
      }
      LiviAppModule.setPendingOpenWelcomeChat(this)
      return
    }
    if (openCalls) {
      intent.removeExtra(EXTRA_OPEN_TAB_FRIENDS)
      if (action == LiviFirebaseMessagingService.ACTION_OPEN_MISSED_CALLS) {
        intent.action = null
      }
      LiviAppModule.setPendingOpenTabFriends(this)
      if (dismissMissed) {
        LiviAppModule.dismissAllMissedCallNotificationsFromContext(this)
        Handler(Looper.getMainLooper()).postDelayed({
          LiviAppModule.dismissAllMissedCallNotificationsFromContext(this@MainActivity)
        }, 150)
      }
    }
  }

  private fun handleReturnToActiveCallIntent(intent: Intent?) {
    if (intent?.getBooleanExtra(EXTRA_RETURN_TO_ACTIVE_CALL, false) != true) return
    val audioOnly = intent.getBooleanExtra(EXTRA_RETURN_TO_ACTIVE_CALL_AUDIO_ONLY, false)
    intent.removeExtra(EXTRA_RETURN_TO_ACTIVE_CALL)
    intent.removeExtra(EXTRA_RETURN_TO_ACTIVE_CALL_AUDIO_ONLY)
    LiviAppModule.setPendingReturnToActiveCall(this, audioOnly)
    LiviAppModule.emitReturnToActiveCallFromNotification(audioOnly)
  }

  /** Кнопка «Аудио» в системном PiP — развернуть приложение и открыть экран аудиозвонка. */
  private fun handleAudioOnlyFromPiPIntent(intent: Intent?) {
    if (intent?.action != LiviAppModule.ACTION_AUDIO_ONLY_FROM_PIP) return
    intent.action = null
    setIntent(intent)
    android.util.Log.i("MainActivity", "PiP action: return to audio call screen")
    LiviAppModule.emitReturnToAudioCallFromPiP()
  }

    companion object {
    const val EXTRA_PENDING_CALL_ACCEPTED_CALL_ID = "pending_call_accepted_call_id"
    const val EXTRA_PENDING_ANSWER_CALL_ID = "pending_answer_call_id"
    const val EXTRA_PENDING_ANSWER_FROM = "pending_answer_from"
    const val EXTRA_PENDING_ANSWER_FROM_NICK = "pending_answer_from_nick"
    /** Accept входящего: показать фон сцены поверх RN до VideoCall.onLayout. */
    const val EXTRA_INCOMING_ANSWER_COVER = "incoming_answer_cover"
    const val EXTRA_OPEN_TAB_FRIENDS = "open_tab_friends"
    /** Тап по уведомлению о непрочитанном сообщении → welcome Chat. */
    const val EXTRA_OPEN_WELCOME_CHAT = "open_welcome_chat"
    /** Тап по ongoing-уведомлению активного видеозвонка — вернуться на экран звонка. */
    const val EXTRA_RETURN_TO_ACTIVE_CALL = "return_to_active_call"
    /** С какого UI ушли в фон (аудио / видео) — для возврата по тапу на ongoing-уведомление. */
    const val EXTRA_RETURN_TO_ACTIVE_CALL_AUDIO_ONLY = "return_to_active_call_audio_only"

    /** Короткая grace для JS AboutToEnter; чуть дольше — стабильнее кадр до enter на OEM. */
    private const val VIDEO_FRAME_GRACE_MS = 200L
    /**
     * First Home/homekey enter often still has window focus — do not abort yet.
     * After this, foreground+focus means user returned; cancel stale retries.
     */
    private const val PIP_ENTER_FOREGROUND_ABORT_AFTER_MS = 350L
    /** Ждём recentapps после leaveHint (Samsung/Pixel: broadcast часто после hint). */
    private const val RECENTS_DETECT_DELAY_MS = 400L
    private const val PIP_ENTER_DEDUP_MS = 2500L
    private val PIP_ENTER_RETRY_DELAYS_MS =
      longArrayOf(16L, 48L, 96L, 160L, 280L, 450L, 700L, 1100L, 1600L)
    /** После последнего ретрая — если вход так и не удался, снять isPiPEnterAttemptRunning.
     * Иначе флаг висит "running" бесконечно, и случайный поздний retryEnterSystemPiPIfLeaveHintPending
     * (например от setSystemPiPCaptureFrameReady) резолвит протухшую попытку через десятки секунд,
     * когда Activity давно не resumed — гарантированный "Activity must be resumed" и шум в логах. */
    private const val PIP_ENTER_GIVE_UP_BUFFER_MS = 300L

    /** true когда приложение на переднем плане (в т.ч. во время видеозвонка) — тогда не показываем heads-up уведомление о звонке */
    @JvmField
    var isInForeground = false

    /** Последний MainActivity в onResume — для закрытия system PiP при call:ended, когда currentActivity == null. */
    @JvmField
    var lastResumedInstance: MainActivity? = null

    /** Как SystemBarsScrim в JS: 70% чёрного поверх фона сцены. */
    private val SIDE_NAV_SCRIM_COLOR = Color.argb(0xB3, 0, 0, 0)

    /** Текущий экземпляр (singleTask): пока Activity под IncomingCallActivity, lastResumedInstance ещё пуст. */
    @Volatile
    private var liveInstance: MainActivity? = null

    /**
     * Поверх экрана блокировки — только пока идёт звонок. Постоянный showWhenLocked
     * в манифесте открывал чаты на заблокированном телефоне любому, кто его взял.
     */
    @Volatile
    private var overLockActiveCall = false

    /** Входящий звонит или только что принят — пока не поднялся сервис активного звонка. */
    @Volatile
    private var overLockIncomingUntil = 0L
    private const val OVER_LOCK_INCOMING_MS = 60_000L

    private fun shouldShowOverLock(): Boolean =
      overLockActiveCall || SystemClock.elapsedRealtime() < overLockIncomingUntil

    @JvmStatic
    fun setOverLockActiveCall(active: Boolean) {
      overLockActiveCall = active
      refreshOverLock()
    }

    @JvmStatic
    fun markIncomingCallOverLock() {
      overLockIncomingUntil = SystemClock.elapsedRealtime() + OVER_LOCK_INCOMING_MS
      refreshOverLock()
      // Звонок так и не стал активным — по истечении окна снова прячемся за блокировку.
      Handler(Looper.getMainLooper()).postDelayed({ refreshOverLock() }, OVER_LOCK_INCOMING_MS + 500)
    }

    private fun refreshOverLock() {
      val act = liveInstance ?: return
      if (act.isFinishing || act.isDestroyed) return
      val show = shouldShowOverLock()
      act.runOnUiThread { act.applyShowOverLock(show) }
    }

    /** Accept уже нажат — держим крышку даже если Activity ещё не получила intent extra. */
    @JvmField
    @Volatile
    var armIncomingAnswerCover: Boolean = false

    @JvmStatic
    fun showIncomingAnswerCoverOnMainIfPossible() {
      armIncomingAnswerCover = true
      val act = lastResumedInstance
      if (act != null && !act.isFinishing && !act.isDestroyed) {
        act.runOnUiThread { act.showIncomingAnswerCover() }
      }
    }

    /** Крышка «Поделиться» держится, пока JS не покажет экран отправки, но не дольше. */
    private const val SHARE_COVER_MAX_MS = 2500L
    /** nativeID корня экрана отправки (IncomingSharePickerModal). */
    private const val SHARE_ROOT_NATIVE_ID = "incoming-share-root"

    @JvmStatic
    fun hideShareCoverOnMainIfPossible() {
      val act = lastResumedInstance
      if (act != null && !act.isFinishing && !act.isDestroyed) {
        act.runOnUiThread { act.hideShareCover() }
      }
    }

    @JvmStatic
    fun hideIncomingAnswerCoverOnMainIfPossible() {
      armIncomingAnswerCover = false
      val act = lastResumedInstance
      if (act != null && !act.isFinishing && !act.isDestroyed) {
        act.runOnUiThread { act.hideIncomingAnswerCover() }
      }
    }
  }
}
