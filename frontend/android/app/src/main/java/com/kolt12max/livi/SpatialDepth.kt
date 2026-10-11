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
  private var targetX = 0f
  private var targetY = 0f
  private val eye = FloatArray(3)
  private var eyeReady = false
  private val rot = FloatArray(9)
  private var lastSensorNs = 0L
  private var lastFrameNs = 0L

  fun addListener(listener: Listener) {
    if (!listeners.contains(listener)) listeners.add(listener)
    listener.onSpatialTilt(x, y)
  }

  fun removeListener(listener: Listener) {
    listeners.remove(listener)
  }

  /** Активный фон держит датчик включённым; последний ушёл — слои плавно возвращаются. */
  fun setDriver(owner: Any, on: Boolean, context: Context) {
    val changed = if (on) drivers.add(owner) else drivers.remove(owner)
    if (!changed) return
    if (drivers.isNotEmpty()) start(context) else stop()
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
    eyeReady = false
    lastSensorNs = 0L
    registered = sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
  }

  private fun stop() {
    if (registered) sensorManager?.unregisterListener(this)
    registered = false
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
    val ex: Float
    val ey: Float
    if (!gravityMode) {
      SensorManager.getRotationMatrixFromVector(rot, event.values)
      // Нормаль экрана в координатах мира — третий столбец R; глаз стоял на ней в исходной позе.
      follow(rot[2], rot[5], rot[8], recenter)
      // Глаз в координатах телефона: Rᵀ · eye.
      ex = rot[0] * eye[0] + rot[3] * eye[1] + rot[6] * eye[2]
      ey = rot[1] * eye[0] + rot[4] * eye[1] + rot[7] * eye[2]
    } else {
      // Без гироскопа: при малых поворотах глаз смещается так же, как «вверх» мира
      // в координатах телефона (поворот в плоскости экрана не виден, его и не ждём).
      val v = event.values
      val len = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).takeIf { it > 0.1f } ?: return
      val ux = v[0] / len
      val uy = v[1] / len
      val uz = v[2] / len
      follow(ux, uy, uz, recenter)
      ex = ux - eye[0]
      ey = uy - eye[1]
    }
    // Экран: x вправо, y вниз; у датчика y — к верхнему краю.
    val tx = tanh(ex / RANGE)
    val ty = tanh(-ey / RANGE)
    if (abs(tx - targetX) < DEADBAND && abs(ty - targetY) < DEADBAND) return
    targetX = tx
    targetY = ty
    postFrame()
  }

  private fun follow(vx: Float, vy: Float, vz: Float, k: Float) {
    if (!eyeReady) {
      eye[0] = vx
      eye[1] = vy
      eye[2] = vz
      eyeReady = true
      return
    }
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
    val settled = abs(targetX - nx) < EPS && abs(targetY - ny) < EPS
    if (settled) {
      nx = targetX
      ny = targetY
    }
    if (nx != x || ny != y) {
      x = nx
      y = ny
      for (i in listeners.indices.reversed()) listeners.getOrNull(i)?.onSpatialTilt(x, y)
    }
    if (settled) {
      lastFrameNs = 0L
    } else {
      lastFrameNs = frameTimeNanos
      postFrame()
    }
  }
}

/** Картинка сцены и её карта глубины (scripts/generate-spatial-depth.js) — один раз на процесс. */
private object SpatialScene {
  private val cache = RenderCache("SpatialScene", capacity = 3)

  fun image(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("image", { decode(context, R.drawable.spatial_stage) }, onReady)

  fun depth(context: Context, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("depth", { decode(context, R.drawable.spatial_stage_depth) }, onReady)

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
 * Дальний слой главного экрана: сцена за стеклом.
 *
 * Android 13+: AGSL-шейдер смещает каждую точку картинки по её глубине (светлые иконки у
 * стекла отстают от дальней дымки — объём внутри самой картинки), свет скользит по сцене
 * вслед за наклоном, кромки ближних иконок вспыхивают со стороны света, по ярким элементам
 * бегут голографические переливы. Ниже 13 — картинка сдвигается целиком.
 *
 * Результат лежит в слое RenderNode и пересчитывается только при наклоне: кадр радара
 * «Поиска» лишь композитит готовую текстуру. Без слоя полноэкранный шейдер на каждом
 * кадре радара брал ~8 мс GPU на A35.
 */
class SpatialBackgroundView(context: Context) : View(context), SpatialTilt.Listener {
  private var active = false
  private var shown = false
  private var driving = false
  private var image: Bitmap? = null
  private var depth: Bitmap? = null
  private var tiltX = 0f
  private var tiltY = 0f
  private val imageMatrix = Matrix()
  private val depthMatrix = Matrix()
  private var geometryKey = ""
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val fallbackPaint = Paint().apply { color = Color.rgb(37, 43, 52) }
  private var scene: Any? = null
  private var blurPx = -1f

  /** Дальний план сцены сдвигается на столько при полном наклоне. */
  private val farShift = PixelUtil.toPixelFromDIP(FAR_SHIFT_DP)
  private val nearShift = PixelUtil.toPixelFromDIP(NEAR_SHIFT_DP)

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    paint.colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setScale(DIM, DIM, DIM, 1f) })
    image = SpatialScene.image(context) { image = it; geometryKey = ""; invalidate() }
    depth = SpatialScene.depth(context) { depth = it; geometryKey = ""; invalidate() }
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
    updateDriver()
  }

  private fun updateDriver() {
    val on = active && shown && isAttachedToWindow
    if (on == driving) return
    driving = on
    SpatialTilt.setDriver(this, on, context)
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
  private fun updateGeometry(img: Bitmap, dep: Bitmap?) {
    val key = "${width}x$height:${img.width}:${dep?.width}"
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
    if (dep != null) {
      val ds = scale * img.width / dep.width
      depthMatrix.setScale(ds, ds)
      depthMatrix.postTranslate(tx, ty)
    }
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
    val dep = depth
    updateGeometry(img, dep)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && dep != null && canvas.isHardwareAccelerated) {
      val s = (scene as? DepthScene) ?: DepthScene(context).also { scene = it }
      s.draw(canvas, img, dep, imageMatrix, depthMatrix, width, height, tiltX, tiltY, farShift, nearShift, blurPx)
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
    private var boundImage: Bitmap? = null
    private var boundDepth: Bitmap? = null
    private var imageShader: BitmapShader? = null
    private var depthShader: BitmapShader? = null

    init {
      shader.setInputShader("noise", StageBackground.noiseShader(context))
      shader.setColorUniform("glowColor", Color.rgb(98, 176, 216))
      paint.shader = shader
    }

    fun draw(
      canvas: Canvas,
      img: Bitmap,
      dep: Bitmap,
      imageMatrix: Matrix,
      depthMatrix: Matrix,
      w: Int,
      h: Int,
      tiltX: Float,
      tiltY: Float,
      farShift: Float,
      nearShift: Float,
      blurPx: Float,
    ) {
      if (boundImage !== img) {
        imageShader = BitmapShader(img, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
          filterMode = BitmapShader.FILTER_MODE_LINEAR
        }
        boundImage = img
      }
      if (boundDepth !== dep) {
        depthShader = BitmapShader(dep, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
          filterMode = BitmapShader.FILTER_MODE_LINEAR
        }
        boundDepth = dep
      }
      imageShader!!.setLocalMatrix(imageMatrix)
      depthShader!!.setLocalMatrix(depthMatrix)
      shader.setInputShader("scene", imageShader!!)
      shader.setInputShader("depth", depthShader!!)
      shader.setFloatUniform("size", w.toFloat(), h.toFloat())
      shader.setFloatUniform("tilt", tiltX, tiltY)
      shader.setFloatUniform("farShift", farShift)
      shader.setFloatUniform("nearShift", nearShift)
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
    const val FAR_SHIFT_DP = 14f
    const val MIN_REDRAW_NS = 15_000_000L
    const val NEAR_SHIFT_DP = 5f
    /** Сцена темнее исходника: блоки интерфейса (#2E3540) должны быть светлее неё. */
    const val DIM = 0.66f

    const val AGSL = """
      uniform shader scene;
      uniform shader depth;
      uniform shader noise;
      uniform float2 size;
      uniform float2 tilt;
      uniform float farShift;
      uniform float nearShift;
      uniform float dim;
      layout(color) uniform half4 glowColor;

      float depthAt(float2 p) { return float(depth.eval(p).r); }

      half4 main(float2 p) {
        // Точка сцены видна там, куда её сдвинула глубина: ищем, чья она, в два шага —
        // второй уточняет глубину уже у сдвинутой точки, и края иконок не рвутся.
        float d = depthAt(p);
        float2 off = tilt * mix(farShift, nearShift, d);
        d = depthAt(p - off);
        off = tilt * mix(farShift, nearShift, d);
        float2 q = p - off;
        float3 c = float3(scene.eval(q).rgb);
        float lum = dot(c, float3(0.2126, 0.7152, 0.0722));

        // Свет неподвижен в мире: при наклоне пятно света скользит навстречу,
        // ближние яркие иконки ловят его сильнее дымки.
        float2 lightPos = size * (float2(0.32, 0.22) - tilt * 0.42);
        float2 toLight = (lightPos - p) / size.x;
        float spot = exp(-dot(toLight, toLight) * 2.4);
        float catchLight = smoothstep(0.2, 0.55, lum) * (0.35 + 0.65 * d);

        // Кромка ближних иконок со стороны света: перепад глубины, повёрнутый к свету.
        float h = size.x * 0.004;
        float dq = depthAt(q);
        float2 grad = float2(depthAt(q + float2(h, 0.0)) - dq, depthAt(q + float2(0.0, h)) - dq) * 2.0;
        float2 lightDir = normalize(toLight + float2(1e-4, 0.0));
        float rim = clamp(-dot(grad, lightDir) * 3.2, 0.0, 1.0);

        c *= dim;
        // Виньетка: края темнее — сцена уходит вглубь.
        float2 v = p / size - 0.5;
        float vignette = 1.0 - smoothstep(0.32, 0.95, length(v * float2(1.15, 0.95)));
        c *= mix(0.62, 1.0, vignette);
        float3 glow = float3(glowColor.rgb);
        c += glow * (spot * 0.045 + catchLight * spot * 0.22 + rim * (0.10 + spot * 0.30));

        // Голографический перелив: при наклоне по ярким элементам сцены бегут узкие
        // полосы света со спектром в семье акцента LiVi. Привязан к наклону, а не ко
        // времени: в покое сцену не нужно перерисовывать.
        float band = dot(q / size.x, float2(0.52, 0.86)) * 2.6 + dot(tilt, float2(1.9, 1.4));
        float sheen = pow(0.5 + 0.5 * sin(band * 6.2831853), 8.0);
        float3 spectrum = 0.5 + 0.5 * cos(6.2831853 * (band * 0.5 + float3(0.0, 0.2, 0.4)));
        float3 iridescent = mix(glow, spectrum * float3(0.8, 0.95, 1.0), 0.5);
        c += iridescent * sheen * smoothstep(0.18, 0.5, lum) * 0.32;

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
    translationX = SpatialTilt.x * k
    translationY = SpatialTilt.y * k
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
    private fun level(v: Float): Int {
      val c = (v * 0.66f * 255f).toInt().coerceIn(0, 255)
      return Color.rgb(c, c, c)
    }
    // Градиент в единицах «полуэкрана»: r = 2 · length(v · k) из шейдера, спад до r = 1.9.
    const val VIGNETTE_R = 1.9f
    val VIGNETTE_STOPS = floatArrayOf(0f, 0.64f, 0.9f, 1.2f, 1.5f, 1.75f, 1.9f).map { it / VIGNETTE_R }.toFloatArray()
    val VIGNETTE_COLORS = intArrayOf(level(1f), level(1f), level(0.95f), level(0.84f), level(0.72f), level(0.64f), level(0.62f))
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
