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
 * - боковой (side) — у вертикальных сторон, на скруглениях сходит на нет по углу;
 * - кольцевой (ring) — как нижний, но со всех сторон: вторая тень вокруг блока, раздвинутая
 *   на ringOffset, а снизу ещё на ringDrop (сверху — на ringRise).
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
   * и бокового акцентов относительно основной тени (0 — без них). baseOpacity — плотность
   * самой основной тени (1 — прежняя): под стеклом блока и вокруг него со всех сторон.
   * soft — основная тень и оба акцента (боковой, нижний) гаснут сразу от края блока, без
   * плотной полосы у кромки ([softFalloff]). ringOffset, ringDrop, ringRise
   * и ringOpacity — кольцевой акцент; View тогда шире блока на spread + ringOffset со всех
   * сторон, ещё на ringDrop снизу и на ringRise сверху. ringSoft — кольцо размытое: гаснет
   * сразу от края ([softFalloff]) и плавно заходит под стекло, без тёмного обода по кромке.
   */
  data class Spec(
    val radius: Float,
    val spread: Float,
    val dropOffset: Float,
    val dropOpacity: Float,
    val sideOpacity: Float,
    val baseOpacity: Float = 1f,
    val soft: Boolean = false,
    val ringOffset: Float = 0f,
    val ringOpacity: Float = 0f,
    val ringDrop: Float = 0f,
    val ringRise: Float = 0f,
    val ringSoft: Boolean = false,
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
    val baseAlpha = INNER * spec.baseOpacity.coerceAtLeast(0f)
    private val soft = spec.soft
    private val ring = spec.ringOffset.coerceAtLeast(0f)
    private val ringAlpha = INNER * spec.ringOpacity.coerceAtLeast(0f)
    private val ringDrop = spec.ringDrop.coerceAtLeast(0f)
    private val ringRise = spec.ringRise.coerceAtLeast(0f)
    private val ringSoft = spec.ringSoft
    /** На сколько размытое кольцо заходит под блок. */
    private val ringInner = spread * 0.35f
    /** На столько View шире блока с каждой стороны (снизу — ещё drop). */
    private val pad = spread + ring
    val cx = width / 2f
    val cy = (height - drop - ringDrop + ringRise) / 2f
    private val halfH = cy - pad - ringRise
    /** Скругление и полуразмеры прямого участка блока. */
    val r = min(spec.radius, min(cx - pad, halfH)).coerceAtLeast(0f)
    val hx = max(cx - pad - r, 0f)
    private val hy = max(halfH - r, 0f)

    // Текущая строка.
    private var qy = 0f
    private var qyDrop = 0f
    private var qyRing = 0f
    private var dropWeight = 0f

    /** Готовит строку y; false — в ней нет тени. */
    fun setRow(y: Int): Boolean {
      val py = y + 0.5f
      qy = abs(py - cy) - hy
      qyDrop = abs(py - cy - drop) - hy
      // Кольцо: тот же блок, только снизу длиннее на ringDrop, а сверху на ringRise.
      qyRing = abs(py - cy - (ringDrop - ringRise) / 2f) - hy - (ringDrop + ringRise) / 2f
      // Нижний акцент нарастает от середины блока к его нижнему краю.
      dropWeight = if (dropAlpha > 0f && halfH > 0f) 1f - falloff((py - cy) / halfH, 1f) else 0f
      return qy - r < pad ||
        (dropWeight > 0f && qyDrop - r < spread) ||
        (ringAlpha > 0f && qyRing - r < pad)
    }

    /** Альфа на прямом участке строки: бокового акцента там нет. */
    fun straightTarget(): Float =
      combine(
        if (qy > 0f) qy - r else -r,
        if (qyDrop > 0f) qyDrop - r else -r,
        side = 0f,
        dRing = if (qyRing > 0f) qyRing - r else -r,
      )

    fun target(x: Int): Float {
      val qx = abs(x + 0.5f - cx) - hx
      val ox = max(qx, 0f)
      val oy = max(qy, 0f)
      val d = sqrt(ox * ox + oy * oy) + min(max(qx, qy), 0f) - r
      val dDrop = if (dropWeight > 0f) distance(qx, qyDrop) else spread
      // Доля «сбоку»: 1 у вертикальных сторон, 0 над и под блоком, на скруглениях — по углу.
      val side = if (ox > 0f) ox * ox / (ox * ox + oy * oy) else 0f
      val dRing = if (ringAlpha > 0f) distance(qx, qyRing) else d
      return combine(d, dDrop, side, dRing)
    }

    /** 1 снаружи блока; внутри спадает до 0 за ringInner. */
    private fun innerRamp(d: Float): Float {
      if (d >= 0f) return 1f
      if (ringInner <= 0f) return 0f
      val s = 1f - (-d / ringInner).coerceIn(0f, 1f)
      return s * s
    }

    private fun distance(qx: Float, qy: Float): Float {
      val ox = max(qx, 0f)
      val oy = max(qy, 0f)
      return sqrt(ox * ox + oy * oy) + min(max(qx, qy), 0f) - r
    }

    /**
     * d — до блока (< 0 внутри), dDrop — до блока, сдвинутого вниз на drop, dRing — до
     * блока, удлинённого вниз на ringDrop и вверх на ringRise.
     */
    private fun combine(d: Float, dDrop: Float, side: Float, dRing: Float): Float {
      val near = if (soft) softFalloff(d, spread) else falloff(d, spread)
      val base = baseAlpha * near
      if (dropWeight <= 0f && (side <= 0f || sideAlpha <= 0f) && ringAlpha <= 0f) return base * 255f
      val outside = (d / EDGE_SOFT + 0.5f).coerceIn(0f, 1f)
      val dropNear = if (soft) softFalloff(dDrop, spread) else falloff(dDrop, spread)
      val dropPart = dropAlpha * dropNear * dropWeight * outside
      val sidePart = sideAlpha * near * side * outside
      val ringPart =
        when {
          ringAlpha <= 0f -> 0f
          // Пик на кромке, наружу — мягкий хвост, внутрь — короткий спад под стеклом:
          // ни скачка плотности на краю, ни ровной полосы вдоль него.
          ringSoft -> ringAlpha * softFalloff(dRing - ring, spread) * innerRamp(d)
          else -> ringAlpha * falloff(dRing - ring, spread) * outside
        }
      return (1f - (1f - base) * (1f - dropPart) * (1f - sidePart) * (1f - ringPart)) * 255f
    }
  }

  /**
   * Как [falloff], но без плато у кромки: smoothstep держит ~85% плотности на первой четверти
   * ширины, и тень читается ровной полосой. (1 − s)² убывает сразу от края и плавно, без
   * излома, сходит на нет у внешней границы — тень выглядит размытой.
   */
  private fun softFalloff(d: Float, spread: Float): Float {
    if (d <= 0f) return 1f
    if (d >= spread) return 0f
    val s = 1f - d / spread
    return s * s
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
  private var baseOpacity = 1f
  private var soft = false
  private var ringOffset = 0f
  private var ringOpacity = 0f
  private var ringDrop = 0f
  private var ringRise = 0f
  private var ringSoft = false
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

  fun setBaseOpacity(value: Float) {
    baseOpacity = value
    refresh()
  }

  fun setSoft(value: Boolean) {
    soft = value
    refresh()
  }

  fun setRingOffsetDp(value: Float) {
    ringOffset = PixelUtil.toPixelFromDIP(value)
    refresh()
  }

  fun setRingOpacity(value: Float) {
    ringOpacity = value
    refresh()
  }

  fun setRingDropDp(value: Float) {
    ringDrop = PixelUtil.toPixelFromDIP(value)
    refresh()
  }

  fun setRingRiseDp(value: Float) {
    ringRise = PixelUtil.toPixelFromDIP(value)
    refresh()
  }

  fun setRingSoft(value: Boolean) {
    ringSoft = value
    refresh()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    refresh()
  }

  private fun refresh() {
    val current = ++generation
    val spec =
      FloatShadow.Spec(
        radius, spread, dropOffset, dropOpacity, sideOpacity, baseOpacity, soft, ringOffset, ringOpacity, ringDrop,
        ringRise, ringSoft,
      )
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

  @ReactProp(name = "baseOpacity", defaultFloat = 1f)
  fun setBaseOpacity(view: FloatShadowView, value: Float) = view.setBaseOpacity(value)

  @ReactProp(name = "soft", defaultBoolean = false)
  fun setSoft(view: FloatShadowView, value: Boolean) = view.setSoft(value)

  @ReactProp(name = "ringOffset", defaultFloat = 0f)
  fun setRingOffset(view: FloatShadowView, value: Float) = view.setRingOffsetDp(value)

  @ReactProp(name = "ringOpacity", defaultFloat = 0f)
  fun setRingOpacity(view: FloatShadowView, value: Float) = view.setRingOpacity(value)

  @ReactProp(name = "ringDrop", defaultFloat = 0f)
  fun setRingDrop(view: FloatShadowView, value: Float) = view.setRingDropDp(value)

  @ReactProp(name = "ringRise", defaultFloat = 0f)
  fun setRingRise(view: FloatShadowView, value: Float) = view.setRingRiseDp(value)

  @ReactProp(name = "ringSoft", defaultBoolean = false)
  fun setRingSoft(view: FloatShadowView, value: Boolean) = view.setRingSoft(value)
}
