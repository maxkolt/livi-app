package com.kolt12max.livi

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Мягкая тень «парящего» блока на Android (JS WelcomeFloatShadow).
 *
 * Раньше её давали три вложенных слоя rgba(2, 8, 13, 0.018…0.04). Каждый слой затемняет
 * фон меньше чем на 1 уровень из 255, поэтому после смешивания результат округлялся.
 * Получались три кольца с резкими краями: синий −1, затем зелёный −1 и синий −2, затем
 * зелёный −2 и синий −3. В каждом кольце свой оттенок, и на OLED они рябили.
 *
 * Здесь один слой: чёрный с плавным спадом альфы от края блока наружу на spread. Сама альфа
 * подмешана blue noise, поэтому округление каждого пикселя случайно. Вместо ступенек
 * получается такое же зерно, как у фона (StageBackground). Под блоком альфа постоянная,
 * как и раньше под тремя слоями.
 *
 * Акценты лежат только снаружи блока, поэтому его стекло не темнеет:
 * - нижний (drop) — вторая тень, сдвинутая вниз; нарастает от середины блока к низу;
 * - боковой (side) — у вертикальных сторон, на скруглениях сходит на нет по углу.
 */
object FloatShadow {
  private const val TAG = "FloatShadow"

  /** Сумма прежних трёх слоёв: 1 − (1 − 5/255)(1 − 7/255)(1 − 10/255). */
  private const val INNER = 1f - (250f / 255f) * (248f / 255f) * (245f / 255f)

  /** Акценты обрываются на кромке блока не ступенькой, а за ~2 px. */
  private const val EDGE_SOFT = 2f

  /**
   * Размах шума альфы (±). На тёмном фоне ±6/255 сдвигают синий канал на ±0.7 уровня, а
   * зелёный на ±0.5. Этого хватает, чтобы округление шло случайно, но зерно не грубее фона.
   */
  private const val JITTER = 6f

  /** Сдвиг по тайлу шума: не совпадать с зерном фона под тенью. */
  private const val NOISE_OFFSET_X = 23
  private const val NOISE_OFFSET_Y = 41

  /** Блоки одного размера (сегменты вкладок, круглые кнопки) делят один bitmap. */
  private val cache = RenderCache(TAG, capacity = 16)

  /**
   * Геометрия тени в px. View — это блок со скруглением radius, расширенный на spread со
   * всех сторон и ещё на dropOffset снизу. dropOpacity и sideOpacity — плотность нижнего
   * и бокового акцентов относительно основной тени (0 — без них).
   */
  data class Spec(
    val radius: Float,
    val spread: Float,
    val dropOffset: Float,
    val dropOpacity: Float,
    val sideOpacity: Float,
  )

  /**
   * Тень для View width×height px. Если её ещё нет — null; рендер уходит в фоновый
   * поток, onReady придёт на главном.
   */
  fun bitmap(context: Context, width: Int, height: Int, spec: Spec, onReady: (Bitmap) -> Unit): Bitmap? {
    if (width <= 0 || height <= 0 || spec.spread <= 0f) return null
    val appContext = context.applicationContext
    return cache.get("${width}x$height $spec", { render(appContext, width, height, spec) }, onReady)
  }

  private fun render(context: Context, width: Int, height: Int, spec: Spec): Bitmap {
    val noise = StageBackground.noise(context)
    val n = StageBackground.NOISE_SIZE
    // Новый bitmap уже прозрачный: строки целиком вне тени не трогаем.
    val soft = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val row = IntArray(width)
    val phase = IntArray(n)
    val shape = Shape(width, height, spec)
    // Прямой участок по x (|x − cx| ≤ hx): там расстояние до блока зависит только от y,
    // а бокового акцента нет.
    val midStart = ceil(shape.cx - shape.hx - 0.5f).toInt().coerceIn(0, width)
    val midEnd = (floor(shape.cx + shape.hx - 0.5f).toInt() + 1).coerceIn(midStart, width)
    for (y in 0 until height) {
      if (!shape.setRow(y)) continue
      val noiseRow = ((y + NOISE_OFFSET_Y) % n) * n
      val midTarget = shape.straightTarget()
      for (p in 0 until n) phase[p] = alpha(midTarget, noise[noiseRow + p])
      var p = (midStart + NOISE_OFFSET_X) % n
      for (x in midStart until midEnd) {
        row[x] = phase[p]
        if (++p == n) p = 0
      }
      // Края со скруглениями — полное расстояние до скруглённого прямоугольника.
      for (x in 0 until midStart) row[x] = alpha(shape.target(x), noise[noiseRow + (x + NOISE_OFFSET_X) % n])
      for (x in midEnd until width) row[x] = alpha(shape.target(x), noise[noiseRow + (x + NOISE_OFFSET_X) % n])
      soft.setPixels(row, 0, width, 0, y, width, 1)
    }
    return StageBackground.toGpu(soft)
  }

  /** Блок в координатах View и альфа тени (0…255, без шума) в каждой точке. */
  private class Shape(width: Int, height: Int, spec: Spec) {
    val spread = spec.spread
    val drop = spec.dropOffset.coerceAtLeast(0f)
    val dropAlpha = INNER * spec.dropOpacity.coerceAtLeast(0f)
    val sideAlpha = INNER * spec.sideOpacity.coerceAtLeast(0f)
    val cx = width / 2f
    val cy = (height - drop) / 2f
    private val halfH = cy - spread
    /** Скругление и полуразмеры прямого участка блока. */
    val r = min(spec.radius, min(cx - spread, halfH)).coerceAtLeast(0f)
    val hx = max(cx - spread - r, 0f)
    private val hy = max(halfH - r, 0f)

    // Текущая строка.
    private var qy = 0f
    private var qyDrop = 0f
    private var dropWeight = 0f

    /** Готовит строку y; false — в ней нет тени. */
    fun setRow(y: Int): Boolean {
      val py = y + 0.5f
      qy = abs(py - cy) - hy
      qyDrop = abs(py - cy - drop) - hy
      // Нижний акцент нарастает от середины блока к его нижнему краю.
      dropWeight = if (dropAlpha > 0f && halfH > 0f) 1f - falloff((py - cy) / halfH, 1f) else 0f
      return qy - r < spread || (dropWeight > 0f && qyDrop - r < spread)
    }

    /** Альфа на прямом участке строки: бокового акцента там нет. */
    fun straightTarget(): Float =
      combine(if (qy > 0f) qy - r else -r, if (qyDrop > 0f) qyDrop - r else -r, side = 0f)

    fun target(x: Int): Float {
      val qx = abs(x + 0.5f - cx) - hx
      val ox = max(qx, 0f)
      val oy = max(qy, 0f)
      val d = sqrt(ox * ox + oy * oy) + min(max(qx, qy), 0f) - r
      val dDrop = if (dropWeight > 0f) distance(qx, qyDrop) else spread
      // Доля «сбоку»: 1 у вертикальных сторон, 0 над и под блоком, на скруглениях — по углу.
      val side = if (ox > 0f) ox * ox / (ox * ox + oy * oy) else 0f
      return combine(d, dDrop, side)
    }

    private fun distance(qx: Float, qy: Float): Float {
      val ox = max(qx, 0f)
      val oy = max(qy, 0f)
      return sqrt(ox * ox + oy * oy) + min(max(qx, qy), 0f) - r
    }

    /** d — до блока (< 0 внутри), dDrop — до блока, сдвинутого вниз на drop. */
    private fun combine(d: Float, dDrop: Float, side: Float): Float {
      val near = falloff(d, spread)
      val base = INNER * near
      if (dropWeight <= 0f && (side <= 0f || sideAlpha <= 0f)) return base * 255f
      val outside = (d / EDGE_SOFT + 0.5f).coerceIn(0f, 1f)
      val dropPart = dropAlpha * falloff(dDrop, spread) * dropWeight * outside
      val sidePart = sideAlpha * near * side * outside
      return (1f - (1f - base) * (1f - dropPart) * (1f - sidePart)) * 255f
    }
  }

  /** 1 при d ≤ 0, 0 при d ≥ spread; спад smoothstep — без излома у края и на границе. */
  private fun falloff(d: Float, spread: Float): Float {
    if (d >= spread) return 0f
    val s = (d / spread).coerceIn(0f, 1f)
    return 1f - s * s * (3f - 2f * s)
  }

  /** Чёрный пиксель (premultiplied) с альфой target ± шум порога t ∈ (0, 1). */
  private fun alpha(target: Float, t: Float): Int {
    if (target <= 0f) return 0
    // Шум не больше самой альфы: у внешнего края тень не расползается и не обрезается.
    val jitter = min(JITTER, target)
    return (target + (t - 0.5f) * 2f * jitter).roundToInt().coerceIn(0, 255) shl 24
  }
}

class FloatShadowView(context: Context) : View(context) {
  private var radius = 0f
  private var spread = 0f
  private var dropOffset = 0f
  private var dropOpacity = 0f
  private var sideOpacity = 0f
  private var bitmap: Bitmap? = null
  private var generation = 0

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setRadiusDp(value: Float) {
    radius = PixelUtil.toPixelFromDIP(value)
    refresh()
  }

  fun setSpreadDp(value: Float) {
    spread = PixelUtil.toPixelFromDIP(value)
    refresh()
  }

  fun setDropOffsetDp(value: Float) {
    dropOffset = PixelUtil.toPixelFromDIP(value)
    refresh()
  }

  fun setDropOpacity(value: Float) {
    dropOpacity = value
    refresh()
  }

  fun setSideOpacity(value: Float) {
    sideOpacity = value
    refresh()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    refresh()
  }

  private fun refresh() {
    val current = ++generation
    val spec = FloatShadow.Spec(radius, spread, dropOffset, dropOpacity, sideOpacity)
    bitmap =
      FloatShadow.bitmap(context, width, height, spec) { ready ->
        if (current == generation) {
          bitmap = ready
          invalidate()
        }
      }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val b = bitmap ?: return
    if (StageBackground.canDraw(canvas, b)) canvas.drawBitmap(b, 0f, 0f, null)
  }
}

class FloatShadowViewManager : SimpleViewManager<FloatShadowView>() {
  override fun getName(): String = "LiviFloatShadow"

  override fun createViewInstance(context: ThemedReactContext): FloatShadowView = FloatShadowView(context)

  @ReactProp(name = "radius", defaultFloat = 0f)
  fun setRadius(view: FloatShadowView, value: Float) = view.setRadiusDp(value)

  @ReactProp(name = "spread", defaultFloat = 0f)
  fun setSpread(view: FloatShadowView, value: Float) = view.setSpreadDp(value)

  @ReactProp(name = "dropOffset", defaultFloat = 0f)
  fun setDropOffset(view: FloatShadowView, value: Float) = view.setDropOffsetDp(value)

  @ReactProp(name = "dropOpacity", defaultFloat = 0f)
  fun setDropOpacity(view: FloatShadowView, value: Float) = view.setDropOpacity(value)

  @ReactProp(name = "sideOpacity", defaultFloat = 0f)
  fun setSideOpacity(view: FloatShadowView, value: Float) = view.setSideOpacity(value)
}
