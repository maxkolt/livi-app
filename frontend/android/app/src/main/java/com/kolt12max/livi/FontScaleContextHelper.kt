package com.kolt12max.livi

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.util.DisplayMetrics

/**
 * Фиксирует для приложения «базовый» вид экрана:
 * - размер шрифта (игнор «Размер шрифта»);
 * - плотность dp (игнор «Масштаб экрана» / display size) через [DisplayMetrics.DENSITY_DEVICE_STABLE] (API 24+).
 */
object FontScaleContextHelper {
  fun wrap(context: Context): Context {
    val configuration = Configuration(context.resources.configuration)
    configuration.fontScale = 1f
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      configuration.densityDpi = DisplayMetrics.DENSITY_DEVICE_STABLE
    }
    return context.createConfigurationContext(configuration)
  }
}
