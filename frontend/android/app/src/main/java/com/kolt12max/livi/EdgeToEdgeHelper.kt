package com.kolt12max.livi

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Android 16 (targetSdk 36) enforces edge-to-edge: content draws behind system bars.
 * Safe padding is applied in React Native via react-native-safe-area-context.
 * Native call screens use [applySystemBarInsets] so buttons stay above the nav bar.
 */
object EdgeToEdgeHelper {
  @JvmStatic
  fun apply(activity: Activity) {
    val window = activity.window ?: return
    WindowCompat.setDecorFitsSystemWindows(window, false)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
          } else {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
          }
      }
    }

    // Keep system bars transparent. On API 35+ bar colors are ignored anyway;
    // translucent scrims are drawn by RN SystemBarsScrim for a consistent look.
    @Suppress("DEPRECATION")
    run {
      window.statusBarColor = Color.TRANSPARENT
      window.navigationBarColor = Color.TRANSPARENT
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        window.isStatusBarContrastEnforced = false
        window.isNavigationBarContrastEnforced = false
      }
    }
  }

  /**
   * Adds system-bar insets on top of the view's existing XML padding
   * (so fixed dp paddings like 48dp bottom remain as extra breathing room).
   */
  @JvmStatic
  fun applySystemBarInsets(view: View) {
    val initialLeft = view.paddingLeft
    val initialTop = view.paddingTop
    val initialRight = view.paddingRight
    val initialBottom = view.paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      v.setPadding(
        initialLeft + bars.left,
        initialTop + bars.top,
        initialRight + bars.right,
        initialBottom + bars.bottom,
      )
      insets
    }
    ViewCompat.requestApplyInsets(view)
  }

  /**
   * Для overlay поверх Main: RN часто уже «съел» dispatched insets (top=0),
   * поэтому читаем systemBars с [insetsAnchor] (обычно decorView) и ставим padding вручную.
   * Итог как у IncomingCallActivity: statusBar + XML marginTop(80dp) до ника.
   */
  @JvmStatic
  fun applySystemBarInsetsFromWindow(view: View, insetsAnchor: View) {
    val initialLeft = view.paddingLeft
    val initialTop = view.paddingTop
    val initialRight = view.paddingRight
    val initialBottom = view.paddingBottom

    fun applyFromRoot() {
      val rootInsets = ViewCompat.getRootWindowInsets(insetsAnchor) ?: return
      val bars = rootInsets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(
        initialLeft + bars.left,
        initialTop + bars.top,
        initialRight + bars.right,
        initialBottom + bars.bottom,
      )
    }

    ViewCompat.setOnApplyWindowInsetsListener(view) { _, insets ->
      // Даже если child получил пустой top — берём с корня окна.
      val rootInsets = ViewCompat.getRootWindowInsets(insetsAnchor) ?: insets
      val bars = rootInsets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(
        initialLeft + bars.left,
        initialTop + bars.top,
        initialRight + bars.right,
        initialBottom + bars.bottom,
      )
      insets
    }
    applyFromRoot()
    view.post { applyFromRoot() }
    ViewCompat.requestApplyInsets(view)
  }
}
