package com.kolt12max.livi

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * Язык нативных экранов и уведомлений.
 *
 * Язык UI выбирается в JS (вручную или по системе) и сохраняется сюда через
 * LiviAppModule.setAppLanguage. Нативные экраны звонка и уведомления часто
 * показываются, когда JS не запущен (FCM в убитом процессе), поэтому язык
 * читаем из SharedPreferences, а не спрашиваем у JS.
 *
 * Пустое значение — режим «как в системе»: строки берутся по локали устройства,
 * а для неподдерживаемых языков Android отдаёт values/ (английский).
 */
object AppLocale {
  private const val PREFS = "LiviAppLocale"
  private const val KEY_LANG = "app_lang"

  @Volatile private var cachedTag: String? = null
  @Volatile private var cachedContext: Context? = null

  fun setAppLanguage(context: Context, tag: String?) {
    val normalized = tag?.trim().orEmpty()
    context.applicationContext
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_LANG, normalized)
      .apply()
    synchronized(this) {
      cachedTag = null
      cachedContext = null
    }
  }

  private fun storedTag(context: Context): String =
    try {
      context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getString(KEY_LANG, "")
        .orEmpty()
    } catch (_: Exception) {
      ""
    }

  /** Коды JS (utils/i18n LANGS) → Locale. zh-TW — традиционное письмо. */
  private fun localeForTag(tag: String): Locale? =
    when (tag) {
      "" -> null
      "zh" -> Locale.SIMPLIFIED_CHINESE
      "zh-TW" -> Locale.TRADITIONAL_CHINESE
      else -> Locale.forLanguageTag(tag).takeIf { it.language.isNotEmpty() }
    }

  /** Локаль для форматов дат/«вчера»: язык приложения, иначе системная. */
  fun locale(context: Context): Locale = localeForTag(storedTag(context)) ?: Locale.getDefault()

  /**
   * Контекст с ресурсами на языке приложения. Override содержит только локаль:
   * копия всей Configuration замораживала бы ориентацию и размеры.
   */
  fun context(context: Context): Context {
    val app = context.applicationContext ?: context
    val tag = storedTag(app)
    if (tag.isEmpty()) return app
    synchronized(this) {
      val cached = cachedContext
      if (cached != null && cachedTag == tag) return cached
      val locale = localeForTag(tag) ?: return app
      val override = Configuration()
      override.setLocale(locale)
      val localized = app.createConfigurationContext(override)
      cachedTag = tag
      cachedContext = localized
      return localized
    }
  }

  fun str(context: Context, resId: Int): String = context(context).getString(resId)

  fun str(context: Context, resId: Int, vararg args: Any?): String = context(context).getString(resId, *args)

  fun plural(context: Context, resId: Int, count: Int, vararg args: Any?): String =
    context(context).resources.getQuantityString(resId, count, *args)
}
