package com.kolt12max.livi

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.util.Log
import android.view.View
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt

/**
 * Палитры сцены: тон у верхнего и нижнего края растворяется к середине.
 * CLASSIC — прежняя тёмная сцена (HOME_STAGE_EDGE_RGB → HOME_STAGE_MID в JS).
 * TEAL — новая: тон блоков (UI_SURFACE) → серый «Поиска» (HOME_NAV_BG); имя осталось
 * с бирюзовой версии. Сплэш, экраны звонка, витрина Legendary. Вместе с TEAL_STAGE_* в
 * JS WelcomeStageBackground.
 */
/**
 * reach — какая доля пути от края до середины занята переходом (1 — до самой середины,
 * меньше — переход короче, середина шире чистая).
 */
enum class StagePalette(
  internal val mid: FloatArray,
  internal val edge: FloatArray,
  internal val reach: Float = 1f,
) {
  /** #0C1521 в середине. Было #0A111B: весь синий мягко поднят ×1.22, оттенок тот же. */
  CLASSIC(floatArrayOf(12f, 21f, 33f), floatArrayOf(15f, 30f, 45f)),
  /** #252B34 в середине, #2E3540 у краёв — тон блоков (UI_SURFACE): тот же серо-синий, светлее. */
  TEAL(floatArrayOf(37f, 43f, 52f), floatArrayOf(46f, 53f, 64f)),
  /**
   * Витрина Legendary, сплэш и экраны звонка: края приглушены почти до середины (#282E38),
   * и переход короче (70% пути): середина экрана чисто серая.
   */
  TEAL_DEEP(floatArrayOf(37f, 43f, 52f), floatArrayOf(40f, 46f, 56f), reach = 0.7f);

  internal val midColor: Int = Color.rgb(mid[0].toInt(), mid[1].toInt(), mid[2].toInt())

  companion object {
    fun from(name: String?): StagePalette =
      when (name) {
        "teal" -> TEAL
        "tealDeep" -> TEAL_DEEP
        else -> CLASSIC
      }
  }
}

/**
 * Основной фон LiVi: тон у верхнего и нижнего края растворяется к середине (StagePalette).
 *
 * Тёмному градиенту не хватает 8 бит на канал: без дизеринга он идёт полосами. Градиент
 * HWUI дизерит матрицей Байера, то есть шахматкой с периодом 2 px. Старая PNG была
 * задизерена так же и растягивалась примерно в 2.7 раза. Регулярный узор ±1 уровня
 * на OLED рябит: на Galaxy S26 Ultra (QHD+, LTPO, «Насыщенные» цвета), а в режиме FHD+
 * аппаратный апскейл превращает его в муар.
 *
 * Поэтому bitmap строится ровно в размер View, без масштабирования. Порог дизеринга
 * берётся из blue noise: в нём нет периодики и низких частот. Порог один на все три
 * канала, поэтому цветного шума тоже нет.
 *
 * Bitmap считается в фоновом потоке: на холодном старте, пока JIT не прогрет, QHD+ занимает
 * ~0.1 с. До его готовности тот же профиль рисует градиент HWUI (Fallback).
 */
object StageBackground {
  private const val TAG = "StageBackground"

  /** res/raw/stage_blue_noise.bin — scripts/generate-stage-blue-noise.js. */
  internal const val NOISE_SIZE = 64
  @Volatile private var thresholds: FloatArray? = null

  /** Портрет и ландшафт обеих палитр плюс окно модалки; всё остальное — редкость. */
  private val cache = RenderCache(TAG, capacity = 5)

  /** Опорные точки запасного градиента: по 16 на половину экрана, как HOME_STAGE_FADE_STEPS. */
  private val fallbackPositions = FloatArray(33) { it / 32f }

  private fun fallbackColors(palette: StagePalette): IntArray =
    IntArray(fallbackPositions.size) {
      val alpha = (fade(fallbackPositions[it], palette.reach) * 255f).roundToInt()
      Color.argb(alpha, palette.edge[0].toInt(), palette.edge[1].toInt(), palette.edge[2].toInt())
    }

  /**
   * Bitmap фона ровно width×height px, если уже посчитан. Иначе — null; рендер уходит
   * в фоновый поток, onReady придёт на главном.
   */
  fun bitmap(
    context: Context,
    width: Int,
    height: Int,
    palette: StagePalette,
    onReady: (Bitmap) -> Unit,
  ): Bitmap? {
    if (width <= 0 || height <= 0) return null
    val appContext = context.applicationContext
    return cache.get("${palette.name}:${width}x$height", { render(appContext, width, height, palette) }, onReady)
  }

  /** Bitmap 1:1 без фильтрации; пока его нет или canvas программный — fallback. */
  fun draw(canvas: Canvas, bitmap: Bitmap?, bounds: Rect, fallback: Fallback) {
    if (bitmap != null && canDraw(canvas, bitmap)) {
      canvas.drawBitmap(bitmap, bounds.left.toFloat(), bounds.top.toFloat(), null)
    } else {
      fallback.draw(canvas, bounds)
    }
  }

  /**
   * Тот же профиль градиентом HWUI — на доли секунды, пока считается bitmap. Середина
   * сплошная, края — один тон с плавной альфой: rgb stop'ов округлились бы до 8 бит
   * ступеньками.
   */
  class Fallback(palette: StagePalette = StagePalette.CLASSIC) {
    private val midPaint = Paint()
    private val edgePaint = Paint()
    private var colors = IntArray(0)
    private var top = 0
    private var bottom = 0

    var palette: StagePalette = palette
      set(value) {
        if (field == value) return
        field = value
        apply(value)
      }

    init {
      apply(palette)
    }

    private fun apply(value: StagePalette) {
      midPaint.color = value.midColor
      colors = fallbackColors(value)
      edgePaint.shader = null
    }

    fun draw(canvas: Canvas, bounds: Rect) {
      if (edgePaint.shader == null || bounds.top != top || bounds.bottom != bottom) {
        top = bounds.top
        bottom = bounds.bottom
        edgePaint.shader =
          LinearGradient(
            0f, top.toFloat(), 0f, bottom.toFloat(),
            colors, fallbackPositions, Shader.TileMode.CLAMP,
          )
      }
      canvas.drawRect(bounds, midPaint)
      canvas.drawRect(bounds, edgePaint)
    }
  }

  /** HARDWARE bitmap нельзя рисовать в программный canvas (снимки View в bitmap). */
  internal fun canDraw(canvas: Canvas, bitmap: Bitmap): Boolean =
    canvas.isHardwareAccelerated || Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      bitmap.config != Bitmap.Config.HARDWARE

  /** Пиксели — сразу в GPU: не держим копию (~18 МБ для фона QHD+) в памяти процесса. */
  internal fun toGpu(soft: Bitmap): Bitmap {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      soft.copy(Bitmap.Config.HARDWARE, false)?.let { hardware ->
        soft.recycle()
        return hardware
      }
    }
    return soft
  }

  /**
   * 1 у края экрана, 0 к доле reach пути до середины (дальше — 0); спад по косинусу —
   * без излома ни у края, ни там, где переход кончается.
   */
  private fun fade(position: Float, reach: Float): Float {
    val fromEdge = abs(position - 0.5f) * 2f
    val edge = ((fromEdge - (1f - reach)) / reach).coerceIn(0f, 1f)
    return (1f - cos(PI.toFloat() * edge)) / 2f
  }

  private fun render(context: Context, width: Int, height: Int, palette: StagePalette): Bitmap {
    val mid = palette.mid
    val edge = palette.edge
    val noise = noise(context)
    val soft = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val row = IntArray(width)
    // Тон строки постоянен, шум периодичен по x с шагом тайла: считаем один тайл и копируем.
    val period = minOf(NOISE_SIZE, width)
    for (y in 0 until height) {
      val k = fade((y + 0.5f) / height, palette.reach)
      val r = mid[0] + (edge[0] - mid[0]) * k
      val g = mid[1] + (edge[1] - mid[1]) * k
      val b = mid[2] + (edge[2] - mid[2]) * k
      val noiseRow = (y % NOISE_SIZE) * NOISE_SIZE
      for (x in 0 until period) {
        // floor(c + t) при t ∈ (0, 1): в среднем ровно c, без ступенек.
        val t = noise[noiseRow + x]
        row[x] = (0xFF shl 24) or (channel(r + t) shl 16) or (channel(g + t) shl 8) or channel(b + t)
      }
      var filled = period
      while (filled < width) {
        val len = minOf(filled, width - filled)
        System.arraycopy(row, 0, row, filled, len)
        filled += len
      }
      soft.setPixels(row, 0, width, 0, y, width, 1)
    }
    return toGpu(soft)
  }

  private fun channel(value: Float): Int = value.toInt().coerceIn(0, 255)

  /** Пороги blue noise NOISE_SIZE×NOISE_SIZE в (0, 1). */
  internal fun noise(context: Context): FloatArray {
    thresholds?.let { return it }
    val bytes = context.resources.openRawResource(R.raw.stage_blue_noise).use { it.readBytes() }
    check(bytes.size == NOISE_SIZE * NOISE_SIZE) { "stage_blue_noise: ${bytes.size} bytes" }
    return FloatArray(bytes.size) { ((bytes[it].toInt() and 0xFF) + 0.5f) / 256f }.also { thresholds = it }
  }
}

/** LRU bitmap'ов, которые считаются в фоновом потоке; onReady — на главном. */
internal class RenderCache(private val tag: String, private val capacity: Int) {
  private val ready = LinkedHashMap<String, Bitmap>(capacity, 0.75f, true)
  private val waiting = HashMap<String, MutableList<(Bitmap) -> Unit>>()

  fun get(key: String, render: () -> Bitmap, onReady: (Bitmap) -> Unit): Bitmap? {
    synchronized(this) {
      ready[key]?.let { return it }
      waiting[key]?.let {
        it.add(onReady)
        return null
      }
      waiting[key] = mutableListOf(onReady)
    }
    worker.execute {
      val bitmap =
        try {
          render()
        } catch (e: Throwable) {
          Log.w(tag, "render $key failed", e)
          null
        }
      val callbacks =
        synchronized(this) {
          if (bitmap != null) {
            ready[key] = bitmap
            // Без recycle: вытесненный bitmap может ещё рисоваться в живом View.
            while (ready.size > capacity) ready.remove(ready.keys.first())
          }
          waiting.remove(key).orEmpty()
        }
      if (bitmap != null) main.post { callbacks.forEach { it(bitmap) } }
    }
    return null
  }

  private companion object {
    /** Один поток на фон и тени: считаются по очереди, UI их не ждёт. */
    val worker: ExecutorService =
      Executors.newSingleThreadExecutor { task -> Thread(task, "LiviStageRender").apply { isDaemon = true } }
    val main = Handler(Looper.getMainLooper())
  }
}

/** Фон окна MainActivity: при повороте непокрытые RN полосы совпадают с экраном. */
class StageBackgroundDrawable(
  context: Context,
  private val palette: StagePalette = StagePalette.CLASSIC,
) : Drawable() {
  private val appContext = context.applicationContext
  private val fallback = StageBackground.Fallback(palette)
  private var bitmap: Bitmap? = null
  private var generation = 0

  override fun onBoundsChange(bounds: Rect) {
    val current = ++generation
    bitmap =
      StageBackground.bitmap(appContext, bounds.width(), bounds.height(), palette) { ready ->
        if (current == generation) {
          bitmap = ready
          invalidateSelf()
        }
      }
  }

  override fun draw(canvas: Canvas) = StageBackground.draw(canvas, bitmap, bounds, fallback)

  override fun setAlpha(alpha: Int) {}

  override fun setColorFilter(colorFilter: ColorFilter?) {}

  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.OPAQUE
}

/** Фон JS-экранов через LiviStageBackground (палитра — prop `palette`). */
open class StageBackgroundView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  palette: StagePalette = StagePalette.CLASSIC,
) : View(context, attrs) {
  private val fallback = StageBackground.Fallback(palette)
  private var bitmap: Bitmap? = null
  private var generation = 0
  private val bounds = Rect()

  var palette: StagePalette = palette
    set(value) {
      if (field == value) return
      field = value
      fallback.palette = value
      requestBitmap()
      invalidate()
    }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    bounds.set(0, 0, w, h)
    requestBitmap()
  }

  private fun requestBitmap() {
    val current = ++generation
    bitmap =
      StageBackground.bitmap(context, bounds.width(), bounds.height(), palette) { ready ->
        if (current == generation) {
          bitmap = ready
          invalidate()
        }
      }
  }

  override fun onDraw(canvas: Canvas) = StageBackground.draw(canvas, bitmap, bounds, fallback)
}

/** Экраны входящего и исходящего звонка: сцена витрины Legendary (TEAL_DEEP), поверх — тонировка в layout. */
class TealStageBackgroundView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : StageBackgroundView(context, attrs, StagePalette.TEAL_DEEP)

class StageBackgroundViewManager : SimpleViewManager<StageBackgroundView>() {
  override fun getName(): String = "LiviStageBackground"

  override fun createViewInstance(context: ThemedReactContext): StageBackgroundView =
    StageBackgroundView(context)

  @ReactProp(name = "palette")
  fun setPalette(view: StageBackgroundView, value: String?) {
    view.palette = StagePalette.from(value)
  }
}
