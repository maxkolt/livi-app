package com.kolt12max.livi

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.util.DisplayMetrics

/**
 * Фиксирует для приложения «базовый» вид экрана:
 * - размер шрифта (игнор «Размер шрифта»);
 * - плотность dp (игнор «Масштаб экрана» / display size) через [DisplayMetrics.DENSITY_DEVICE_STABLE] (API 24+).
 *
 * Важно вызывать не только из [attachBaseContext], но и при [onConfigurationChanged] / [applyOverrideConfiguration]
 * в Activity (у [android.app.Application] нет override для [applyOverrideConfiguration] в нашей связке SDK),
 * иначе после смены настроек Android подмешивает новый fontScale/density в уже запущенное приложение.
 */
object FontScaleContextHelper {

  fun patchConfiguration(configuration: Configuration): Configuration {
    configuration.fontScale = 1f
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      configuration.densityDpi = DisplayMetrics.DENSITY_DEVICE_STABLE
    }
    return configuration
  }

  /** Копия системной конфигурации с зафиксированным шрифтом и плотностью (остальные поля сохраняются). */
  fun copyPatched(newConfig: Configuration): Configuration {
    val configuration = Configuration(newConfig)
    return patchConfiguration(configuration)
  }

  /**
   * Override-конфиг содержит ТОЛЬКО fontScale и density.
   *
   * Копия всей [Configuration] делала override-полями ещё и orientation,
   * screenWidthDp/screenHeightDp и windowConfiguration.appBounds. Override
   * перебивает системный конфиг навсегда, поэтому resources этого контекста
   * замерзали на ориентации старта процесса: RN читает
   * applicationContext.resources.displayMetrics (DisplayMetricsHolder), и
   * Dimensions.get('window') после поворота не менялся.
   */
  fun wrap(context: Context): Context {
    val override = Configuration()
    override.fontScale = 1f
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      override.densityDpi = DisplayMetrics.DENSITY_DEVICE_STABLE
    }
    return context.createConfigurationContext(override)
  }
}
