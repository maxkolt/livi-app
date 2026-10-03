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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt

/**
 * Основной фон LiVi: бирюза у верхнего и нижнего края растворяется к середине в #0A111B.
 * Тот же профиль, что у JS WelcomeStageBackground (HOME_STAGE_EDGE_RGB, HOME_STAGE_MID).
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

  /** #0A111B — середина экрана. */
  private val MID = floatArrayOf(10f, 17f, 27f)
  /** Тон у верхнего и нижнего края (HOME_STAGE_EDGE_RGB). */
  private val EDGE = floatArrayOf(12f, 25f, 37f)
  private const val MID_COLOR = 0xFF0A111B.toInt()

  /** res/raw/stage_blue_noise.bin — scripts/generate-stage-blue-noise.js. */
  internal const val NOISE_SIZE = 64
  @Volatile private var thresholds: FloatArray? = null

  /** Портрет, ландшафт и окно модалки; всё остальное — редкость. */
  private val cache = RenderCache(TAG, capacity = 3)

  /** Опорные точки запасного градиента: по 16 на половину экрана, как HOME_STAGE_FADE_STEPS. */
  private val fallbackPositions = FloatArray(33) { it / 32f }
  private val fallbackColors =
    IntArray(fallbackPositions.size) {
      val alpha = (fade(fallbackPositions[it]) * 255f).roundToInt()
      Color.argb(alpha, EDGE[0].toInt(), EDGE[1].toInt(), EDGE[2].toInt())
    }

  /**
   * Bitmap фона ровно width×height px, если уже посчитан. Иначе — null; рендер уходит
   * в фоновый поток, onReady придёт на главном.
   */
  fun bitmap(context: Context, width: Int, height: Int, onReady: (Bitmap) -> Unit): Bitmap? {
    if (width <= 0 || height <= 0) return null
    val appContext = context.applicationContext
    return cache.get("${width}x$height", { render(appContext, width, height) }, onReady)
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
  class Fallback {
    private val midPaint = Paint().apply { color = MID_COLOR }
    private val edgePaint = Paint()
    private var top = 0
    private var bottom = 0

    fun draw(canvas: Canvas, bounds: Rect) {
      if (edgePaint.shader == null || bounds.top != top || bounds.bottom != bottom) {
        top = bounds.top
        bottom = bounds.bottom
        edgePaint.shader =
          LinearGradient(
            0f, top.toFloat(), 0f, bottom.toFloat(),
            fallbackColors, fallbackPositions, Shader.TileMode.CLAMP,
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

  /** 1 у края экрана, 0 в середине; спад по косинусу — без излома ни у края, ни в середине. */
  private fun fade(position: Float): Float {
    val edge = abs(position - 0.5f) * 2f
    return (1f - cos(PI.toFloat() * edge)) / 2f
  }

  private fun render(context: Context, width: Int, height: Int): Bitmap {
    val noise = noise(context)
    val soft = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val row = IntArray(width)
    // Тон строки постоянен, шум периодичен по x с шагом тайла: считаем один тайл и копируем.
    val period = minOf(NOISE_SIZE, width)
    for (y in 0 until height) {
      val k = fade((y + 0.5f) / height)
      val r = MID[0] + (EDGE[0] - MID[0]) * k
      val g = MID[1] + (EDGE[1] - MID[1]) * k
      val b = MID[2] + (EDGE[2] - MID[2]) * k
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
class StageBackgroundDrawable(context: Context) : Drawable() {
  private val appContext = context.applicationContext
  private val fallback = StageBackground.Fallback()
  private var bitmap: Bitmap? = null
  private var generation = 0

  override fun onBoundsChange(bounds: Rect) {
    val current = ++generation
    bitmap =
      StageBackground.bitmap(appContext, bounds.width(), bounds.height()) { ready ->
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

/** Фон экранов звонка и крышки accept; через LiviStageBackground — фон JS-экранов. */
class StageBackgroundView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : View(context, attrs) {
  private val fallback = StageBackground.Fallback()
  private var bitmap: Bitmap? = null
  private var generation = 0
  private val bounds = Rect()

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    bounds.set(0, 0, w, h)
    val current = ++generation
    bitmap =
      StageBackground.bitmap(context, w, h) { ready ->
        if (current == generation) {
          bitmap = ready
          invalidate()
        }
      }
  }

  override fun onDraw(canvas: Canvas) = StageBackground.draw(canvas, bitmap, bounds, fallback)
}

class StageBackgroundViewManager : SimpleViewManager<StageBackgroundView>() {
  override fun getName(): String = "LiviStageBackground"

  override fun createViewInstance(context: ThemedReactContext): StageBackgroundView =
    StageBackgroundView(context)
}
