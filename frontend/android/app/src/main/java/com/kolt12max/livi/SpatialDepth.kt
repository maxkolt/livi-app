package com.kolt12max.livi

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.provider.Settings
import android.view.Choreographer
import android.view.View
import android.view.ViewTreeObserver
import android.view.animation.DecelerateInterpolator
import androidx.annotation.RequiresApi
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.round
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * Пространственная глубина главного экрана — как Spatial Photo и параллакс обоев iPhone.
 *
 * Экран — окно. Сцена (картинка) лежит за стеклом: её дальний план смещается вслед за
 * глазом сильнее, ближние иконки сцены — слабее. Интерфейс парит перед стеклом и
 * смещается в обратную сторону. Тени блоков отстают от них — свет неподвижен.
 *
 * Положение глаза относительно телефона: game rotation vector (гироскоп + акселерометр,
 * без компаса — не дрейфует от магнитов), без гироскопа — только гравитация. Глаз считается
 * неподвижным в мире и медленно подстраивается под позу: держишь телефон под любым углом —
 * сцена возвращается в центр, а откликается на сами движения.
 *
 * Один источник на всё: фон, слои интерфейса и тени получают одно и то же значение в одном
 * кадре Choreographer — рассинхрона между слоями нет. Слои сдвигаются translation'ом
 * RenderNode: без layout и без перерисовки содержимого. Датчик работает, только пока на
 * экране есть активный фон; телефон неподвижен — кадры не запрашиваются вовсе.
 */
object SpatialTilt : SensorEventListener, Choreographer.FrameCallback {
  fun interface Listener {
    /** x, y в [-1, 1]: смещение глаза в координатах экрана (x вправо, y вниз). */
    fun onSpatialTilt(x: Float, y: Float)
  }

  /** Отклонение глаза, при котором слои доходят до полного сдвига: sin 15°. */
  private const val RANGE = 0.26f
  /** Ноль подстраивается под позу за ~2.5 с. */
  private const val RECENTER_TAU_S = 2.5f
  /** Сглаживание дрожи руки; меньше — резче, больше — вязко. */
  private const val SMOOTH_TAU_S = 0.07f
  private const val EPS = 0.0005f
  /**
   * Шум датчика лежащего телефона (±0.005, замер на A35) и медленное возвращение нуля
   * меняют цель на тысячные: 0.01 — это 0.14 dp сдвига сцены, глазу не видно, а сцена
   * в покое не пересчитывается.
   */
  private const val DEADBAND = 0.01f
  /**
   * После включения датчика game rotation vector первые доли секунды уточняет позу: всё это
   * время глаз держится на месте относительно телефона, слои не дёргаются.
   */
  private const val WARMUP_NS = 300_000_000L

  private val listeners = ArrayList<Listener>()
  private val drivers = HashSet<Any>()
  private var sensorManager: SensorManager? = null
  private var registered = false
  private var gravityMode = false
  private var framePosted = false

  var x = 0f
    private set
  var y = 0f
    private set
  /**
   * Сдвиг дошёл до цели и замер: слои интерфейса встают на целые пиксели — текст и картинки
   * без билинейного подмыливания от дробного сдвига.
   */
  var settled = true
    private set
  private var targetX = 0f
  private var targetY = 0f
  private val eye = FloatArray(3)
  private val rot = FloatArray(9)
  /**
   * Глаз относительно телефона на последнем отсчёте (с гироскопом — направление в координатах
   * телефона, без него — отклонение от гравитации). Пауза запоминает его, и после возвращения
   * в приложение сдвиг продолжается с того же места, а не встаёт в центр.
   */
  private val phoneEye = FloatArray(3)
  private var resumeFromPhoneEye = false
  private var firstSensorNs = 0L
  private var lastSensorNs = 0L
  private var lastFrameNs = 0L

  fun addListener(listener: Listener) {
    if (!listeners.contains(listener)) listeners.add(listener)
    listener.onSpatialTilt(x, y)
  }

  fun removeListener(listener: Listener) {
    listeners.remove(listener)
  }

  /**
   * Активный фон держит датчик включённым; последний ушёл — слои плавно возвращаются.
   * hold — фон лишь скрыт (приложение в фоне, экран погас): датчик на паузе, слои стоят где
   * были и после возвращения продолжают с того же места.
   */
  fun setDriver(owner: Any, on: Boolean, context: Context, hold: Boolean = false) {
    val changed = if (on) drivers.add(owner) else drivers.remove(owner)
    if (!changed) return
    when {
      drivers.isNotEmpty() -> start(context)
      hold -> pause()
      else -> stop()
    }
  }

  private fun start(context: Context) {
    if (registered || motionReduced(context)) return
    val sm =
      sensorManager
        ?: (context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager)
          ?.also { sensorManager = it }
        ?: return
    val game = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    val sensor = game ?: sm.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    if (sensor == null) return
    gravityMode = game == null
    firstSensorNs = 0L
    lastSensorNs = 0L
    registered = sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
  }

  private fun pause() {
    if (registered) sensorManager?.unregisterListener(this)
    // Глаз относительно телефона — с последнего отсчёта; не было отсчётов — прежний.
    if (registered && firstSensorNs != 0L) resumeFromPhoneEye = true
    registered = false
  }

  private fun stop() {
    if (registered) sensorManager?.unregisterListener(this)
    registered = false
    resumeFromPhoneEye = false
    targetX = 0f
    targetY = 0f
    postFrame()
  }

  /** «Удаление анимаций» в специальных возможностях — без параллакса, как на iPhone. */
  private fun motionReduced(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

  override fun onSensorChanged(event: SensorEvent) {
    val dt = if (lastSensorNs == 0L) 0f else ((event.timestamp - lastSensorNs) / 1e9f).coerceIn(0f, 0.2f)
    lastSensorNs = event.timestamp
    val recenter = 1f - exp(-dt / RECENTER_TAU_S)
    if (firstSensorNs == 0L) firstSensorNs = event.timestamp
    val warming = event.timestamp - firstSensorNs < WARMUP_NS
    val ex: Float
    val ey: Float
    if (!gravityMode) {
      SensorManager.getRotationMatrixFromVector(rot, event.values)
      if (warming) {
        // Пока поза уточняется — глаз там же относительно телефона: по нормали экрана при
        // первом включении, где был — после паузы.
        val p = if (resumeFromPhoneEye) phoneEye else NORMAL
        for (i in 0..2) eye[i] = rot[i * 3] * p[0] + rot[i * 3 + 1] * p[1] + rot[i * 3 + 2] * p[2]
      } else {
        // Нормаль экрана в координатах мира — третий столбец R; глаз стоял на ней в исходной позе.
        follow(rot[2], rot[5], rot[8], recenter)
      }
      // Глаз в координатах телефона: Rᵀ · eye.
      ex = rot[0] * eye[0] + rot[3] * eye[1] + rot[6] * eye[2]
      ey = rot[1] * eye[0] + rot[4] * eye[1] + rot[7] * eye[2]
      phoneEye[0] = ex
      phoneEye[1] = ey
      phoneEye[2] = rot[2] * eye[0] + rot[5] * eye[1] + rot[8] * eye[2]
    } else {
      // Без гироскопа: при малых поворотах глаз смещается так же, как «вверх» мира
      // в координатах телефона (поворот в плоскости экрана не виден, его и не ждём).
      val v = event.values
      val len = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).takeIf { it > 0.1f } ?: return
      val ux = v[0] / len
      val uy = v[1] / len
      val uz = v[2] / len
      if (warming) {
        val p = if (resumeFromPhoneEye) phoneEye else ZERO
        eye[0] = ux - p[0]
        eye[1] = uy - p[1]
        eye[2] = uz - p[2]
      } else {
        follow(ux, uy, uz, recenter)
      }
      ex = ux - eye[0]
      ey = uy - eye[1]
      phoneEye[0] = ex
      phoneEye[1] = ey
      phoneEye[2] = uz - eye[2]
    }
    // Экран: x вправо, y вниз; у датчика y — к верхнему краю.
    val tx = tanh(ex / RANGE)
    val ty = tanh(-ey / RANGE)
    if (abs(tx - targetX) < DEADBAND && abs(ty - targetY) < DEADBAND) return
    targetX = tx
    targetY = ty
    postFrame()
  }

  private val NORMAL = floatArrayOf(0f, 0f, 1f)
  private val ZERO = floatArrayOf(0f, 0f, 0f)

  private fun follow(vx: Float, vy: Float, vz: Float, k: Float) {
    eye[0] += (vx - eye[0]) * k
    eye[1] += (vy - eye[1]) * k
    eye[2] += (vz - eye[2]) * k
    val len = sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]).takeIf { it > 1e-4f } ?: return
    eye[0] /= len
    eye[1] /= len
    eye[2] /= len
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  private fun postFrame() {
    if (framePosted) return
    framePosted = true
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    framePosted = false
    val dt = if (lastFrameNs == 0L) 1f / 60f else ((frameTimeNanos - lastFrameNs) / 1e9f).coerceIn(0.001f, 0.05f)
    val k = 1f - exp(-dt / SMOOTH_TAU_S)
    var nx = x + (targetX - x) * k
    var ny = y + (targetY - y) * k
    val done = abs(targetX - nx) < EPS && abs(targetY - ny) < EPS
    if (done) {
      nx = targetX
      ny = targetY
    }
    if (nx != x || ny != y || done != settled) {
      x = nx
      y = ny
      settled = done
      for (i in listeners.indices.reversed()) listeners.getOrNull(i)?.onSpatialTilt(x, y)
    }
    if (done) {
      lastFrameNs = 0L
    } else {
      lastFrameNs = frameTimeNanos
      postFrame()
    }
  }
}

/** Сцена и её слои по глубине (scripts/generate-spatial-depth.js) — один раз на процесс. */
private object SpatialScene {
  private val cache = RenderCache("SpatialScene", capacity = 6)

  /** Картинка целиком — Android 12 и ниже сдвигает её одним планом. */
  fun image(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("image", { decode(context, R.drawable.spatial_stage) }, onReady)

  /** Фон без элементов — дальний план. */
  fun plate(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("plate", { decode(context, R.drawable.spatial_stage_plate) }, onReady)

  /** Элементы: разность картинки и фона со смещением LAYER_OFFSET. */
  fun layers(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("layers", { decode(context, R.drawable.spatial_stage_layers) }, onReady)

  /** План каждого пикселя слоя, ½ размера сцены. */
  fun planes(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("planes", { decode(context, R.drawable.spatial_stage_planes) }, onReady)

  /** Планы рядом с плиткой — шейдер проверяет только их. */
  fun tiles(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("tiles", { decode(context, R.drawable.spatial_stage_tiles) }, onReady)

  /** Размытая копия сцены для стеклянных блоков (SpatialGlassView). */
  fun blurred(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("blurred", { decode(context, R.drawable.spatial_stage_blur) }, onReady)

  private fun decode(context: Context, res: Int): Bitmap {
    val options =
      BitmapFactory.Options().apply {
        inScaled = false
        inPreferredConfig = Bitmap.Config.ARGB_8888
      }
    val bitmap = BitmapFactory.decodeResource(context.applicationContext.resources, res, options)
    return StageBackground.toGpu(bitmap)
  }
}

/**
 * Дальний слой главного экрана: сцена за стеклом — Spatial Scene.
 *
 * Android 13+: картинка разложена на чистый фон и элементы на пяти планах глубины
 * (scripts/generate-spatial-depth.js). AGSL-шейдер сдвигает каждый план целиком — пиксели не
 * растягиваются, края не плывут, а за сдвинувшимся элементом открывается восстановленный фон;
 * в покое фон + элементы = исходная картинка. Свет скользит по сцене вслед за наклоном, по
 * ярким элементам бегут переливы. Ниже 13 — картинка сдвигается целиком.
 *
 * Результат лежит в слое RenderNode и пересчитывается только при наклоне: кадр радара
 * «Поиска» лишь композитит готовую текстуру. Без слоя полноэкранный шейдер на каждом
 * кадре радара брал ~8 мс GPU на A35.
 */
class SpatialBackgroundView(context: Context) : View(context), SpatialTilt.Listener {
  private var active = false
  private var shown = false
  private var driving = false
  private val layered = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
  /** Картинка, по которой раскладывается cover: фон слоёв (13+) или картинка целиком. */
  private var image: Bitmap? = null
  private var layers: Bitmap? = null
  private var planes: Bitmap? = null
  private var tiles: Bitmap? = null
  private var tiltX = 0f
  private var tiltY = 0f
  private val imageMatrix = Matrix()
  private var geometryKey = ""
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val fallbackPaint = Paint().apply { color = Color.rgb(37, 43, 52) }
  private var scene: Any? = null
  private var blurPx = -1f

  /** Дальний план сцены сдвигается на столько при полном наклоне. */
  private val farShift = PixelUtil.toPixelFromDIP(FAR_SHIFT_DP)
  private val nearShift = PixelUtil.toPixelFromDIP(PLANE_SHIFT_DP.last())
  private val planeShift = FloatArray(PLANE_SHIFT_DP.size) { PixelUtil.toPixelFromDIP(PLANE_SHIFT_DP[it]) }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    paint.colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setScale(DIM, DIM, DIM, 1f) })
    if (layered) {
      image = SpatialScene.plate(context) { image = it; geometryKey = ""; invalidate() }
      layers = SpatialScene.layers(context) { layers = it; invalidate() }
      planes = SpatialScene.planes(context) { planes = it; invalidate() }
      tiles = SpatialScene.tiles(context) { tiles = it; invalidate() }
    } else {
      image = SpatialScene.image(context) { image = it; geometryKey = ""; invalidate() }
    }
  }

  fun setActive(value: Boolean) {
    active = value
    updateDriver()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    SpatialTilt.addListener(this)
    shown = windowVisibility == VISIBLE
    updateDriver()
    activeScene = java.lang.ref.WeakReference(this)
  }

  override fun onDetachedFromWindow() {
    shown = false
    updateDriver()
    SpatialTilt.removeListener(this)
    if (activeScene?.get() === this) activeScene = null
    super.onDetachedFromWindow()
  }

  /**
   * Для стеклянных блоков: матрица cover для копии сцены шириной bitmapWidth (в координатах
   * этого View). false — сцена ещё не разложена.
   */
  internal fun sceneMatrix(bitmapWidth: Int, out: Matrix): Boolean {
    val img = image ?: return false
    if (geometryKey.isEmpty() || bitmapWidth <= 0) return false
    out.set(imageMatrix)
    val k = img.width / bitmapWidth.toFloat()
    out.preScale(k, k)
    return true
  }

  /** Сдвиг сцены при полном наклоне для размытой копии — средний план. */
  internal val glassShift: Float
    get() = (farShift + nearShift) / 2f

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    shown = visibility == VISIBLE
    // Окно скрыто — приложение в фоне или экран погас: пауза, а не возврат в центр.
    updateDriver(hold = !shown)
  }

  private fun updateDriver(hold: Boolean = false) {
    val on = active && shown && isAttachedToWindow
    if (on == driving) return
    driving = on
    SpatialTilt.setDriver(this, on, context, hold)
  }

  override fun onSpatialTilt(x: Float, y: Float) {
    if (x == tiltX && y == tiltY) return
    tiltX = x
    tiltY = y
    // Сцену при движении — не чаще ~60 раз в секунду: дальний план медленный и мягкий,
    // а слой интерфейса над ней по-прежнему сдвигается на каждом кадре 90–120 Гц.
    val sinceDraw = System.nanoTime() - lastDrawNs
    if (sinceDraw >= MIN_REDRAW_NS) {
      invalidate()
    } else if (!redrawPosted) {
      redrawPosted = true
      postOnAnimationDelayed(redraw, (MIN_REDRAW_NS - sinceDraw) / 1_000_000L)
    }
  }

  private var lastDrawNs = 0L
  private var redrawPosted = false
  private val redraw = Runnable {
    redrawPosted = false
    invalidate()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    geometryKey = ""
  }

  /** Cover с запасом на полный сдвиг дальнего плана с каждой стороны. */
  private fun updateGeometry(img: Bitmap) {
    val key = "${width}x$height:${img.width}"
    if (key == geometryKey) return
    geometryKey = key
    val margin = farShift + 2f
    val w = width + margin * 2f
    val h = height + margin * 2f
    val scale = max(w / img.width, h / img.height)
    val tx = (width - img.width * scale) / 2f
    val ty = (height - img.height * scale) / 2f
    imageMatrix.setScale(scale, scale)
    imageMatrix.postTranslate(tx, ty)
    // Растянутая сильнее ~2.6 раза (альбомная, крупный планшет) картинка мылится
    // и показывает JPEG — слегка размываем её как глубокий фон.
    blurPx = ((scale - 2.6f) * PixelUtil.toPixelFromDIP(2.5f)).coerceIn(0f, PixelUtil.toPixelFromDIP(8f))
    if (Build.VERSION.SDK_INT in Build.VERSION_CODES.S until Build.VERSION_CODES.TIRAMISU) {
      setRenderEffect(if (blurPx > 0.5f) RenderEffect.createBlurEffect(blurPx, blurPx, Shader.TileMode.CLAMP) else null)
    }
  }

  override fun onDraw(canvas: Canvas) {
    lastDrawNs = System.nanoTime()
    val img = image
    if (img == null || !StageBackground.canDraw(canvas, img)) {
      canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fallbackPaint)
      return
    }
    updateGeometry(img)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val lay = layers
      val pl = planes
      val tl = tiles
      if (lay == null || pl == null || tl == null || !canvas.isHardwareAccelerated) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fallbackPaint)
        return
      }
      val s = (scene as? DepthScene) ?: DepthScene(context).also { scene = it }
      s.draw(canvas, img, lay, pl, tl, imageMatrix, width, height, tiltX, tiltY, farShift, planeShift, blurPx)
      return
    }
    // Без AGSL: сцена сдвигается целиком, как средний план.
    val shift = (farShift + nearShift) / 2f
    val s = canvas.save()
    canvas.translate(tiltX * shift, tiltY * shift)
    canvas.drawBitmap(img, imageMatrix, paint)
    canvas.restoreToCount(s)
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private class DepthScene(context: Context) {
    private val shader = RuntimeShader(AGSL)
    private val paint = Paint()
    private val node = RenderNode("LiviSpatialScene").apply { setUseCompositingLayer(true, null) }
    private var nodeBlur = -1f
    private val bound = arrayOfNulls<Bitmap>(4)
    private val shaders = arrayOfNulls<BitmapShader>(4)
    private val localMatrix = Matrix()
    private val m = FloatArray(9)

    init {
      shader.setInputShader("noise", StageBackground.noiseShader(context))
      shader.setColorUniform("glowColor", Color.rgb(98, 176, 216))
      paint.shader = shader
    }

    /** Текстура слоя: фон и элементы — с фильтрацией, номера планов — как есть. */
    private fun bind(slot: Int, name: String, bitmap: Bitmap, linear: Boolean, matrix: Matrix) {
      val s =
        shaders[slot]?.takeIf { bound[slot] === bitmap }
          ?: BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
            filterMode = if (linear) BitmapShader.FILTER_MODE_LINEAR else BitmapShader.FILTER_MODE_NEAREST
            bound[slot] = bitmap
            shaders[slot] = this
          }
      s.setLocalMatrix(matrix)
      shader.setInputShader(name, s)
    }

    fun draw(
      canvas: Canvas,
      plate: Bitmap,
      layers: Bitmap,
      planes: Bitmap,
      tiles: Bitmap,
      imageMatrix: Matrix,
      w: Int,
      h: Int,
      tiltX: Float,
      tiltY: Float,
      farShift: Float,
      planeShift: FloatArray,
      blurPx: Float,
    ) {
      bind(0, "plate", plate, true, imageMatrix)
      bind(1, "layers", layers, true, imageMatrix)
      localMatrix.set(imageMatrix)
      val k = plate.width / planes.width.toFloat()
      localMatrix.preScale(k, k)
      bind(2, "planes", planes, false, localMatrix)
      localMatrix.set(imageMatrix)
      localMatrix.preScale(TILE_PX, TILE_PX)
      bind(3, "tiles", tiles, false, localMatrix)
      imageMatrix.getValues(m)
      shader.setFloatUniform("imageRect", m[Matrix.MTRANS_X], m[Matrix.MTRANS_Y], plate.width * m[Matrix.MSCALE_X], plate.height * m[Matrix.MSCALE_Y])
      shader.setFloatUniform("size", w.toFloat(), h.toFloat())
      shader.setFloatUniform("tilt", tiltX, tiltY)
      shader.setFloatUniform("farShift", farShift)
      shader.setFloatUniform("planeShift", planeShift)
      shader.setFloatUniform("dim", DIM)

      val lw = ceil(w / RES_DIVISOR).toInt().coerceAtLeast(1)
      val lh = ceil(h / RES_DIVISOR).toInt().coerceAtLeast(1)
      node.setPosition(0, 0, lw, lh)
      if (abs(blurPx - nodeBlur) > 0.5f) {
        nodeBlur = blurPx
        val r = blurPx / RES_DIVISOR
        node.setRenderEffect(if (r > 0.3f) RenderEffect.createBlurEffect(r, r, Shader.TileMode.CLAMP) else null)
      }
      val rc = node.beginRecording(lw, lh)
      try {
        // Шейдер получает координаты полного размера — меняется только число пикселей.
        rc.scale(lw / w.toFloat(), lh / h.toFloat())
        rc.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
      } finally {
        node.endRecording()
      }
      val save = canvas.save()
      canvas.scale(w / lw.toFloat(), h / lh.toFloat())
      canvas.drawRenderNode(node)
      canvas.restoreToCount(save)
    }
  }

  internal companion object {
    /** Фон главного экрана, под которым лежат стеклянные блоки. */
    internal var activeScene: java.lang.ref.WeakReference<SpatialBackgroundView>? = null

    /** Сцена — Real-ESRGAN 1440 px (scripts/generate-spatial-depth.js): полное разрешение. */
    const val RES_DIVISOR = 1f
    /** Фон без элементов — дальше всех. */
    const val FAR_SHIFT_DP = 14f
    /**
     * Планы 1…5 (spatial_stage_planes.png) при полном наклоне: панели данных и соты, карта,
     * мелкие частицы, иконки и кубы, облако и крупное боке. Чем ближе к стеклу, тем меньше
     * сдвиг: между фоном и облаком ~35 px на A35 — объём читается, а слой не «плывёт».
     */
    val PLANE_SHIFT_DP = floatArrayOf(12f, 10f, 7.5f, 5f, 2.5f)
    /** Плитка spatial_stage_tiles.png, px картинки (TILE в generate-spatial-depth.js). */
    const val TILE_PX = 32f
    const val MIN_REDRAW_NS = 15_000_000L
    /** Сцена чуть темнее картинки: блоки интерфейса (#2E3540) должны быть светлее неё. */
    const val DIM = 0.8f
    /** Яркость краёв в виньетке сцены (mix(VIGNETTE_MIN, 1, …) в шейдере). */
    const val VIGNETTE_MIN = 0.8f

    /**
     * Числа формата слоёв — из generate-spatial-depth.js: LAYER_OFFSET 64 (ноль разности),
     * PLANE_STEP 40 (номер плана), TILE_BIT_STEP 8 (биты планов плитки).
     */
    const val AGSL = """
      uniform shader plate;
      uniform shader layers;
      uniform shader planes;
      uniform shader tiles;
      uniform shader noise;
      uniform float2 size;
      uniform float2 tilt;
      uniform float farShift;
      uniform float planeShift[5];
      uniform float4 imageRect;
      uniform float dim;
      layout(color) uniform half4 glowColor;

      half4 main(float2 p) {
        // Дальний план — фон без элементов.
        float3 c = float3(plate.eval(p - tilt * farShift).rgb);
        // Элементы: каждый план сдвигается целиком, без растяжения. Проверяются только планы,
        // что есть рядом (биты плитки); точка слоя — его, если номер плана совпал.
        float bits = floor(float(tiles.eval(p).r) * 255.0 / 8.0 + 0.5);
        float strongest = 0.0;
        float sheenShift = farShift;
        for (int k = 0; k < 5; k++) {
          if (mod(floor(bits / exp2(float(k))), 2.0) < 0.5) continue;
          float s = planeShift[k];
          float2 q = p - tilt * s;
          if (abs(float(planes.eval(q).r) * 255.0 / 40.0 - float(k + 1)) > 0.5) continue;
          float3 d = float3(layers.eval(q).rgb) - 64.0 / 255.0;
          c += d;
          float amount = d.r + d.g + d.b;
          if (amount > strongest) {
            strongest = amount;
            sheenShift = s;
          }
        }
        c = clamp(c, 0.0, 1.0);
        float lum = dot(c, float3(0.2126, 0.7152, 0.0722));
        // Глубина для отлива — 0 у фона, 1 у ближнего плана.
        float d = (farShift - sheenShift) / max(1.0, farShift - planeShift[4]);
        float2 q = p - tilt * sheenShift;

        // Свет неподвижен в мире: при наклоне пятно света скользит навстречу, яркие элементы
        // ловят его. Купол к середине картинки — как у прежней карты глубины: в покое сцена
        // светится так же, как раньше.
        float2 uv = (p - imageRect.xy) / imageRect.zw;
        float2 dome = (uv - float2(0.5, 0.48)) / 0.5;
        float lift = 0.18 * max(0.0, 1.0 - dot(dome, dome));
        float2 lightPos = size * (float2(0.32, 0.22) - tilt * 0.42);
        float2 toLight = (lightPos - p) / size.x;
        float spot = exp(-dot(toLight, toLight) * 2.4);
        float catchLight = smoothstep(0.2, 0.55, lum) * (0.35 + 0.65 * lift);

        c *= dim;
        // Виньетка: края темнее — сцена уходит вглубь.
        float2 v = p / size - 0.5;
        float vignette = 1.0 - smoothstep(0.32, 0.95, length(v * float2(1.15, 0.95)));
        c *= mix(0.8, 1.0, vignette);
        // Свет — только на самих элементах (без светлого пятна по фону: оно читалось туманом).
        float3 glow = float3(glowColor.rgb);
        c += glow * (catchLight * spot * 0.22);

        // Перелив: мягкий отлив по самим элементам, а не полосы по экрану. Два плавных поля
        // под разными углами, по несколько периодов на ширину экрана — оттенок меняется в
        // пределах иконки, соседние иконки переливаются по-разному, и общей бегущей полосы
        // нет. Поле привязано к элементу и едет с его планом; ближние планы смещаются по фазе
        // сильнее дальних. Только от наклона, не от времени: в покое сцену не нужно
        // перерисовывать.
        float2 uq = q / size.x;
        float phase = 0.9 + 0.6 * d;
        float f1 = sin(6.2831853 * (dot(uq, float2(0.83, 0.56)) * 3.1 + dot(tilt, float2(0.55, 0.3)) * phase));
        float f2 = sin(6.2831853 * (dot(uq, float2(-0.47, 0.88)) * 2.3 + dot(tilt, float2(-0.25, 0.5)) * phase));
        float field = 0.5 + 0.25 * f1 + 0.25 * f2;
        // Только голубая гамма LiVi (без сирени — она читалась фиолетовым): голубой акцент →
        // ледяной → светло-голубой.
        float3 accent = float3(glowColor.rgb);
        float3 ice = float3(0.58, 0.80, 1.0);
        float3 frost = float3(0.80, 0.93, 1.0);
        float3 hue = field < 0.5 ? mix(accent, ice, field * 2.0) : mix(ice, frost, field * 2.0 - 1.0);
        float shine = 0.6 + 0.4 * (0.5 + 0.5 * f1 * f2);
        // Фон картинки после осветления — lum 0.215…0.235: старая маска давала ему ~15%
        // перелива, и f1·f2 шахматкой пятен ползло по всему экрану при наклоне. Отсечка
        // чуть выше фона гасит его; элементам ярче 0.29 перелив остаётся прежним.
        float element = smoothstep(0.16, 0.45, lum) * smoothstep(0.235, 0.29, lum);
        c += hue * element * shine * 0.13;

        // Blue noise ±0.5 уровня до округления: тёмные переходы без полос.
        c += (float(noise.eval(p).r) - 0.5) / 255.0;
        return half4(half3(c), 1.0);
      }
    """
  }
}

/**
 * Слой интерфейса над сценой: смещается против глаза на depth dp при полном наклоне.
 * enabled=false — плавно возвращается в покой (вкладка с видео во весь экран).
 */
class SpatialLayerView(context: Context) : ReactViewGroup(context), SpatialTilt.Listener {
  private var depthPx = 0f
  private var weight = 1f
  private var layerEnabled = true
  private var weightAnimator: ValueAnimator? = null

  fun setDepthDp(value: Float) {
    depthPx = PixelUtil.toPixelFromDIP(value)
    applyShift()
  }

  fun setLayerEnabled(value: Boolean) {
    if (value == layerEnabled) return
    layerEnabled = value
    weightAnimator?.cancel()
    weightAnimator =
      ValueAnimator.ofFloat(weight, if (value) 1f else 0f).apply {
        duration = 280
        interpolator = DecelerateInterpolator()
        addUpdateListener {
          weight = it.animatedValue as Float
          applyShift()
        }
        start()
      }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    SpatialTilt.addListener(this)
  }

  override fun onDetachedFromWindow() {
    SpatialTilt.removeListener(this)
    weightAnimator?.cancel()
    super.onDetachedFromWindow()
  }

  override fun onSpatialTilt(x: Float, y: Float) = applyShift()

  private fun applyShift() {
    val k = -depthPx * weight
    var tx = SpatialTilt.x * k
    var ty = SpatialTilt.y * k
    // В покое — на целый пиксель: дробный сдвиг слегка размывает текст, аватары и иконки.
    // Скачок меньше полпикселя при остановке не виден.
    if (SpatialTilt.settled && (weight == 0f || weight == 1f)) {
      tx = round(tx)
      ty = round(ty)
    }
    translationX = tx
    translationY = ty
  }
}

/**
 * Стеклянный блок над сценой: строки списков, «Пригласить друзей», карточки профиля.
 *
 * Под собой показывает кусок заранее размытой сцены (spatial_stage_blur.jpg) — с тем же
 * cover, сдвигом от наклона, затемнением и виньеткой, что у фона, — сверху тонировку, блик и
 * светлую кромку. Живое размытие (RenderEffect) на каждой строке при прокрутке и наклоне —
 * десятки проходов за кадр; здесь одна отрисовка картинки на блок.
 *
 * Перерисовывается, только когда кусок сцены под блоком сместился на STICKY_PX и больше:
 * под таким размытием сдвиг на пару пикселей не виден, а каждая перерисовка строки заново
 * размывает стекло шапки и дока над списком. Без сцены (другой экран) — сплошной fallback.
 */
class SpatialGlassView(context: Context) : View(context), SpatialTilt.Listener {
  private var radius = 0f
  private var tint = Color.TRANSPARENT
  private var fallback = Color.TRANSPARENT
  private var blurred: Bitmap? = null
  private var blurredShader: BitmapShader? = null
  private val sceneMatrix = Matrix()
  private val vignetteMatrix = Matrix()
  private val scenePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val vignettePaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = RadialGradient(0f, 0f, VIGNETTE_R, VIGNETTE_COLORS, VIGNETTE_STOPS, Shader.TileMode.CLAMP)
      xfermode = PorterDuffXfermode(PorterDuff.Mode.MULTIPLY)
    }
  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val sheenPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rimPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = PixelUtil.toPixelFromDIP(0.8f)
      color = Color.argb(30, 255, 255, 255)
    }
  private val rect = RectF()
  private val selfLoc = IntArray(2)
  private val sceneLoc = IntArray(2)
  private var drawnX = Float.NaN
  private var drawnY = Float.NaN
  private var sheenHeight = -1f

  private val preDraw =
    ViewTreeObserver.OnPreDrawListener {
      checkOffset()
      true
    }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    blurred = SpatialScene.blurred(context) { blurred = it; blurredShader = null; invalidate() }
  }

  fun setRadiusDp(value: Float) {
    radius = PixelUtil.toPixelFromDIP(value)
    invalidate()
  }

  fun setTint(value: Int) {
    tint = value
    invalidate()
  }

  fun setFallback(value: Int) {
    fallback = value
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    SpatialTilt.addListener(this)
    viewTreeObserver.addOnPreDrawListener(preDraw)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDraw)
    SpatialTilt.removeListener(this)
    super.onDetachedFromWindow()
  }

  override fun onSpatialTilt(x: Float, y: Float) = checkOffset()

  /** Экранное положение сцены и своё: кусок сцены под блоком — их разность плюс наклон. */
  private fun sceneOffset(scene: SpatialBackgroundView) {
    scene.getLocationOnScreen(sceneLoc)
    getLocationOnScreen(selfLoc)
  }

  private fun checkOffset() {
    val scene = SpatialBackgroundView.activeScene?.get() ?: return
    sceneOffset(scene)
    val shift = scene.glassShift
    val ox = sceneLoc[0] - selfLoc[0] + SpatialTilt.x * shift
    val oy = sceneLoc[1] - selfLoc[1] + SpatialTilt.y * shift
    if (drawnX.isNaN() || abs(ox - drawnX) >= STICKY_PX || abs(oy - drawnY) >= STICKY_PX) invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    rect.set(0f, 0f, w, h)
    val scene = SpatialBackgroundView.activeScene?.get()?.takeIf { it.isAttachedToWindow }
    val bmp = blurred
    if (scene == null || bmp == null || !StageBackground.canDraw(canvas, bmp) || !scene.sceneMatrix(bmp.width, sceneMatrix)) {
      if (Color.alpha(fallback) != 0) {
        fillPaint.color = fallback
        canvas.drawRoundRect(rect, radius, radius, fillPaint)
      }
      drawnX = Float.NaN
      return
    }
    sceneOffset(scene)
    val shift = scene.glassShift
    val ox = sceneLoc[0] - selfLoc[0] + SpatialTilt.x * shift
    val oy = sceneLoc[1] - selfLoc[1] + SpatialTilt.y * shift
    drawnX = ox
    drawnY = oy

    val shader =
      blurredShader ?: BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).also { blurredShader = it }
    sceneMatrix.postTranslate(ox, oy)
    shader.setLocalMatrix(sceneMatrix)
    scenePaint.shader = shader
    canvas.drawRoundRect(rect, radius, radius, scenePaint)

    // Затемнение и виньетка сцены (как в шейдере фона) — умножением поверх копии.
    val sw = scene.width.toFloat()
    val sh = scene.height.toFloat()
    vignetteMatrix.setScale(sw / 2f / VIGNETTE_X, sh / 2f / VIGNETTE_Y)
    vignetteMatrix.postTranslate(sceneLoc[0] - selfLoc[0] + sw / 2f, sceneLoc[1] - selfLoc[1] + sh / 2f)
    vignettePaint.shader.setLocalMatrix(vignetteMatrix)
    canvas.drawRoundRect(rect, radius, radius, vignettePaint)

    fillPaint.color = tint
    canvas.drawRoundRect(rect, radius, radius, fillPaint)
    // Блик сверху и светлая кромка — блок читается стеклом, а не дыркой в фоне.
    if (sheenHeight != h) {
      sheenHeight = h
      sheenPaint.shader =
        LinearGradient(0f, 0f, 0f, h * 0.55f, Color.argb(16, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
    }
    canvas.drawRoundRect(rect, radius, radius, sheenPaint)
    val inset = rimPaint.strokeWidth / 2f
    rect.inset(inset, inset)
    canvas.drawRoundRect(rect, radius - inset, radius - inset, rimPaint)
  }

  private companion object {
    const val STICKY_PX = 3f
    /** Виньетка фона: смещение от центра, умноженное на (1.15, 0.95), smoothstep 0.32…0.95 → 1…0.62. */
    const val VIGNETTE_X = 1.15f
    const val VIGNETTE_Y = 0.95f
    /** Яркость виньетки сцены с её затемнением: f — доля «центра» (1 — центр, 0 — край). */
    private fun level(f: Float): Int {
      val v = SpatialBackgroundView.VIGNETTE_MIN + (1f - SpatialBackgroundView.VIGNETTE_MIN) * f
      val c = (v * SpatialBackgroundView.DIM * 255f).toInt().coerceIn(0, 255)
      return Color.rgb(c, c, c)
    }
    // Градиент в единицах «полуэкрана»: r = 2 · length(v · k) из шейдера, спад до r = 1.9.
    const val VIGNETTE_R = 1.9f
    val VIGNETTE_STOPS = floatArrayOf(0f, 0.64f, 0.9f, 1.2f, 1.5f, 1.75f, 1.9f).map { it / VIGNETTE_R }.toFloatArray()
    val VIGNETTE_COLORS = intArrayOf(level(1f), level(1f), level(0.87f), level(0.58f), level(0.26f), level(0.05f), level(0f))
  }
}

class SpatialBackgroundViewManager : SimpleViewManager<SpatialBackgroundView>() {
  override fun getName(): String = "LiviSpatialBackground"

  override fun createViewInstance(context: ThemedReactContext): SpatialBackgroundView = SpatialBackgroundView(context)

  @ReactProp(name = "active", defaultBoolean = false)
  fun setActive(view: SpatialBackgroundView, value: Boolean) = view.setActive(value)
}

class SpatialLayerViewManager : ReactViewManager() {
  override fun getName(): String = "LiviSpatialLayer"

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = SpatialLayerView(context)

  @ReactProp(name = "depth", defaultFloat = 0f)
  fun setDepth(view: ReactViewGroup, value: Float) = (view as SpatialLayerView).setDepthDp(value)

  @ReactProp(name = "layerEnabled", defaultBoolean = true)
  fun setLayerEnabled(view: ReactViewGroup, value: Boolean) = (view as SpatialLayerView).setLayerEnabled(value)
}

class SpatialGlassViewManager : SimpleViewManager<SpatialGlassView>() {
  override fun getName(): String = "LiviSpatialGlass"

  override fun createViewInstance(context: ThemedReactContext): SpatialGlassView = SpatialGlassView(context)

  @ReactProp(name = "radius", defaultFloat = 0f)
  fun setRadius(view: SpatialGlassView, value: Float) = view.setRadiusDp(value)

  @ReactProp(name = "tint", customType = "Color", defaultInt = Color.TRANSPARENT)
  fun setTint(view: SpatialGlassView, value: Int) = view.setTint(value)

  @ReactProp(name = "fallbackColor", customType = "Color", defaultInt = Color.TRANSPARENT)
  fun setFallbackColor(view: SpatialGlassView, value: Int) = view.setFallback(value)
}
