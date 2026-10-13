package com.kolt12max.livi

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
import androidx.annotation.RequiresApi
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * Пространственная глубина главного экрана — как Spatial Photo и параллакс обоев iPhone.
 *
 * Экран — окно. Сцена (картинка) лежит за стеклом: её дальний план смещается вслед за
 * глазом сильнее, ближние иконки сцены — слабее. Интерфейс — плоскость стекла и стоит на
 * месте: при входе в приложение с наклоном было видно, как радар и кнопки сами доезжают.
 * Тени блоков чуть отстают от них — свет неподвижен.
 *
 * Положение глаза относительно телефона: game rotation vector (гироскоп + акселерометр,
 * без компаса — не дрейфует от магнитов), без гироскопа — только гравитация. Глаз считается
 * неподвижным в мире и подстраивается под позу, пока телефон поворачивают: держишь его под
 * любым углом — сцена со временем в центре, но сама, без движения, не едет.
 *
 * Один источник на всё: сцена, стекло и тени получают одно и то же значение в одном кадре
 * Choreographer — рассинхрона нет. Датчик работает, только пока на экране есть активный фон;
 * телефон неподвижен — кадры не запрашиваются вовсе.
 */
object SpatialTilt : SensorEventListener, Choreographer.FrameCallback {
  fun interface Listener {
    /** x, y в [-1, 1]: смещение глаза в координатах экрана (x вправо, y вниз). */
    fun onSpatialTilt(x: Float, y: Float)
  }

  /** Отклонение глаза, при котором слои доходят до полного сдвига: sin 15°. */
  private const val RANGE = 0.26f
  /**
   * Ноль подстраивается под позу вместе с движением телефона: за каждые RECENTER_ANGLE рад
   * поворота — на 63%. Пока телефон неподвижен, слои стоят: прежний возврат за 2.5 с сам
   * уводил радар с аватаром к центру — заметно сразу после входа в приложение с наклоном.
   */
  private const val RECENTER_ANGLE = 0.6f
  /** Поворот медленнее ~6°/с — дрожь руки и шум датчика: ноль от него не сдвигается. */
  private const val RECENTER_MIN_SPEED = 0.1f
  /** Совсем медленно ноль догоняет позу и без движения — лежащий телефон не держит сдвиг вечно. */
  private const val RECENTER_TAU_S = 60f
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
  /** Прошлое направление нормали экрана (без гироскопа — «вверх» мира): мера поворота. */
  private val lastNormal = FloatArray(3)
  private var hasLastNormal = false
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
    hasLastNormal = false
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
    if (firstSensorNs == 0L) firstSensorNs = event.timestamp
    val warming = event.timestamp - firstSensorNs < WARMUP_NS
    val ex: Float
    val ey: Float
    if (!gravityMode) {
      SensorManager.getRotationMatrixFromVector(rot, event.values)
      val recenter = recenterStep(rot[2], rot[5], rot[8], dt)
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
      val recenter = recenterStep(ux, uy, uz, dt)
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

  /** Доля, на которую ноль догоняет позу на этом отсчёте: по повороту и (медленно) по времени. */
  private fun recenterStep(vx: Float, vy: Float, vz: Float, dt: Float): Float {
    val turned =
      if (hasLastNormal) {
        val dx = vx - lastNormal[0]
        val dy = vy - lastNormal[1]
        val dz = vz - lastNormal[2]
        max(0f, sqrt(dx * dx + dy * dy + dz * dz) - RECENTER_MIN_SPEED * dt)
      } else {
        0f
      }
    lastNormal[0] = vx
    lastNormal[1] = vy
    lastNormal[2] = vz
    hasLastNormal = true
    return 1f - exp(-turned / RECENTER_ANGLE - dt / RECENTER_TAU_S)
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
    if (nx != x || ny != y) {
      x = nx
      y = ny
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
  /** Шесть исходных картинок и пересчитанные под экран фон и элементы (портрет и альбом). */
  private val cache = RenderCache("SpatialScene", capacity = 10)

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

  /**
   * Элементы, один раз пересчитанные под экран (SharpGeometry). Сжатие картинки в шейдере
   * билинейное: мелкие цифры и точки карты резкие только там, где пиксель экрана попадает в
   * пиксель картинки, — через ~15 px полосами мылятся, а при дробном сдвиге «дышат». Здесь —
   * Ланцош один раз, а шейдер берёт пиксель в пиксель и сдвигает на целые. Фону без элементов
   * это не нужно: он гладкий.
   */
  fun sharpLayers(context: Context, geo: SharpGeometry, onReady: (Bitmap) -> Unit): Bitmap? =
    cache.get("layers@${geo.key}", { resample(context, R.drawable.spatial_stage_layers, geo) }, onReady)

  private fun options() =
    BitmapFactory.Options().apply {
      inScaled = false
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }

  private fun decode(context: Context, res: Int): Bitmap {
    val bitmap = BitmapFactory.decodeResource(context.applicationContext.resources, res, options())
    return StageBackground.toGpu(bitmap)
  }

  /**
   * Два прохода Ланцоша-3 (строки, затем столбцы) в целых числах. Между проходами — 10 бит на
   * канал, в конце — округление через blue noise: ровный тёмный фон без ступенек. Элементы
   * занимают ~17% картинки, остальное — ноль разности: считаются только блоки по 32 px, где
   * элементы есть, — в 3–5 раз быстрее.
   */
  private fun resample(context: Context, res: Int, geo: SharpGeometry): Bitmap {
    val src = BitmapFactory.decodeResource(context.applicationContext.resources, res, options())
    val sw = src.width
    val sh = src.height
    val px = IntArray(sw * sh)
    src.getPixels(px, 0, sw, 0, 0, sw, sh)
    src.recycle()
    val w = geo.width
    val h = geo.height
    val xs = LanczosTaps(w, sw, geo.scale, geo.left - geo.tx)
    val ys = LanczosTaps(h, sh, geo.scale, geo.top - geo.ty)
    // Блоки — не больше 64 на строку: маска строки в одном Long.
    val sBlock = max(BLOCK, (sw + 63) / 64)
    val oBlock = max(BLOCK, (w + 63) / 64)
    // Каким блокам источника касаются отсчёты точки x результата.
    val reach = LongArray(w) { x ->
      val t = x * xs.count
      var m = 0L
      for (b in xs.index[t] / sBlock..xs.index[t + xs.count - 1] / sBlock) m = m or (1L shl b)
      m
    }

    val mid = IntArray(w * sh)
    val midMask = LongArray(sh)
    for (y in 0 until sh) {
      val row = y * sw
      var present = 0L
      for (x in 0 until sw) if (px[row + x] != EMPTY) present = present or (1L shl (x / sBlock))
      val outRow = y * w
      if (present == 0L) {
        mid.fill(EMPTY10, outRow, outRow + w)
        continue
      }
      var mask = 0L
      for (x in 0 until w) {
        if ((present and reach[x]) == 0L) {
          mid[outRow + x] = EMPTY10
          continue
        }
        // r и b — в одном Long (по 32 бита на канал), g отдельно: два умножения на отсчёт.
        var rb = 0L
        var g = 0
        var t = x * xs.count
        for (k in 0 until xs.count) {
          val wt = xs.weight[t]
          val c = px[row + xs.index[t]]
          rb += wt.toLong() * ((((c shr 16) and 0xFF).toLong() shl 32) or (c and 0xFF).toLong())
          g += wt * ((c shr 8) and 0xFF)
          t++
        }
        // Нижняя половина может уйти в минус (отрицательные лепестки) и занять бит у верхней.
        val b = rb.toInt()
        val r = ((rb - b.toLong()) shr 32).toInt()
        mid[outRow + x] = (to10(r) shl 20) or (to10(g) shl 10) or to10(b)
        mask = mask or (1L shl (x / oBlock))
      }
      midMask[y] = mask
    }

    val noise = StageBackground.noise(context)
    val n = StageBackground.NOISE_SIZE
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val line = IntArray(w)
    val ar = IntArray(w)
    val ag = IntArray(w)
    val ab = IntArray(w)
    for (y in 0 until h) {
      val t0y = y * ys.count
      var mask = 0L
      for (k in 0 until ys.count) mask = mask or midMask[ys.index[t0y + k]]
      line.fill(EMPTY)
      val noiseRow = (y % n) * n
      var b = 0
      while (mask != 0L) {
        if ((mask and 1L) != 0L) {
          val x0 = b * oBlock
          val x1 = minOf(w, x0 + oBlock)
          ar.fill(0, x0, x1)
          ag.fill(0, x0, x1)
          ab.fill(0, x0, x1)
          for (k in 0 until ys.count) {
            val wt = ys.weight[t0y + k]
            if (wt == 0) continue
            val row = ys.index[t0y + k] * w
            for (x in x0 until x1) {
              val c = mid[row + x]
              ar[x] += wt * ((c shr 20) and 0x3FF)
              ag[x] += wt * ((c shr 10) and 0x3FF)
              ab[x] += wt * (c and 0x3FF)
            }
          }
          for (x in x0 until x1) {
            // Сумма — уровень × 4 × 2^14; порог blue noise до отбрасывания дробной части.
            val d = (noise[noiseRow + x % n] * 65536f).toInt()
            line[x] = (0xFF shl 24) or (to8(ar[x], d) shl 16) or (to8(ag[x], d) shl 8) or to8(ab[x], d)
          }
        }
        mask = mask ushr 1
        b++
      }
      bitmap.setPixels(line, 0, w, 0, y, w, 1)
    }
    return StageBackground.toGpu(bitmap)
  }

  /** Сумма весов 2^14 × уровень 0…255 → 10 бит (уровень × 4). */
  private fun to10(v: Int): Int = ((v + (1 shl 11)) shr 12).coerceIn(0, 1023)

  private fun to8(v: Int, dither: Int): Int = ((v + dither) shr 16).coerceIn(0, 255)

  /** Ноль разности в слое элементов — LAYER_OFFSET 64 (generate-spatial-depth.js). */
  private const val EMPTY = (0xFF shl 24) or (64 shl 16) or (64 shl 8) or 64
  private const val EMPTY10 = (256 shl 20) or (256 shl 10) or 256
  private const val BLOCK = 32
}

/**
 * Кусок сцены, пересчитанный под экран: пиксель (i, j) — точка (left + i, top + j) View, а
 * исходная картинка ложится как cover: scale и сдвиг (tx, ty). Запас по краям — на сдвиг планов.
 */
internal class SharpGeometry(
  val scale: Float,
  val tx: Float,
  val ty: Float,
  val left: Int,
  val top: Int,
  val width: Int,
  val height: Int,
) {
  val key = "$scale:$tx:$ty:$left:$top:${width}x$height"
}

/**
 * Веса Ланцоша-3 по одной оси: точка i результата берёт картинку около (i + 0.5 + shift) / scale − 0.5.
 * При сжатии ядро растягивается на 1/scale — без алиасинга. Веса в 1/2^14, сумма ровно 2^14:
 * ровный фон остаётся ровным.
 */
private class LanczosTaps(outN: Int, srcN: Int, scale: Float, shift: Float) {
  val count: Int
  val index: IntArray
  val weight: IntArray

  init {
    val stretch = max(1f, 1f / scale)
    val support = LANCZOS_A * stretch
    count = ceil(support * 2f).toInt() + 1
    index = IntArray(outN * count)
    weight = IntArray(outN * count)
    val f = FloatArray(count)
    for (i in 0 until outN) {
      val u = (i + 0.5f + shift) / scale - 0.5f
      val first = floor(u - support).toInt() + 1
      var sum = 0f
      for (k in 0 until count) {
        f[k] = lanczos((first + k - u) / stretch)
        sum += f[k]
      }
      val base = i * count
      var total = 0
      var peak = 0
      for (k in 0 until count) {
        val wt = round(f[k] / sum * ONE).toInt()
        index[base + k] = (first + k).coerceIn(0, srcN - 1)
        weight[base + k] = wt
        total += wt
        if (wt > weight[base + peak]) peak = k
      }
      weight[base + peak] += ONE - total
    }
  }

  private fun lanczos(x: Float): Float {
    if (x == 0f) return 1f
    if (abs(x) >= LANCZOS_A) return 0f
    val px = PI.toFloat() * x
    return LANCZOS_A * sin(px) * sin(px / LANCZOS_A) / (px * px)
  }

  private companion object {
    const val LANCZOS_A = 3f
    const val ONE = 1 shl 14
  }
}

/**
 * Дальний слой главного экрана: сцена за стеклом — Spatial Scene.
 *
 * Android 13+: картинка разложена на чистый фон и элементы на пяти планах глубины
 * (scripts/generate-spatial-depth.js). AGSL-шейдер сдвигает каждый план целиком — пиксели не
 * растягиваются, края не плывут, а за сдвинувшимся элементом открывается восстановленный фон;
 * в покое фон + элементы = исходная картинка. Свет скользит по сцене вслед за наклоном, по
 * ярким элементам бегут переливы, а элементы — голограмма: кромка граней к свету, блик по
 * краю и строки развёртки на иконках, всё пиксель в пиксель. Ниже 13 — картинка сдвигается
 * целиком.
 *
 * Элементы один раз пересчитываются под экран (SpatialScene.sharpLayers), и их планы сдвигаются на
 * целые пиксели: шейдер берёт их пиксель в пиксель — резко и в покое, и в движении.
 * Пока пересчёт не готов (доли секунды после старта или поворота) — прежняя выборка по матрице.
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
  /** Пересчитанные под текущий экран фон и элементы; null — ещё считаются. */
  private var sharp: SharpGeometry? = null
  private var sharpLayers: Bitmap? = null
  /** Размер устоялся — тогда и считаем: промежуточные размеры при старте не тратят CPU. */
  private val requestSharp = Runnable { loadSharp() }

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

  /** Наклон, с которым сцена нарисована: по нему стекло над ней берёт свой кусок. */
  internal val drawnTiltX: Float
    get() = tiltX
  internal val drawnTiltY: Float
    get() = tiltY

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    SpatialTilt.addListener(this)
    shown = windowVisibility == VISIBLE
    updateDriver()
    attachedScenes.add(this)
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(requestSharp)
    shown = false
    updateDriver()
    SpatialTilt.removeListener(this)
    attachedScenes.remove(this)
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
    // Сцену при движении — не чаще ~60 раз в секунду: она сдвигается на целые пиксели,
    // а между перерисовками экран лишь композитит готовый слой.
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
    sharp = null
    sharpLayers = null
    removeCallbacks(requestSharp)
    if (layered) postDelayed(requestSharp, SHARP_DELAY_MS)
    // Растянутая сильнее ~2.6 раза (альбомная, крупный планшет) картинка мылится
    // и показывает JPEG — слегка размываем её как глубокий фон.
    blurPx = ((scale - 2.6f) * PixelUtil.toPixelFromDIP(2.5f)).coerceIn(0f, PixelUtil.toPixelFromDIP(8f))
    if (Build.VERSION.SDK_INT in Build.VERSION_CODES.S until Build.VERSION_CODES.TIRAMISU) {
      setRenderEffect(if (blurPx > 0.5f) RenderEffect.createBlurEffect(blurPx, blurPx, Shader.TileMode.CLAMP) else null)
    }
  }

  /** Кусок сцены под экраном с запасом на полный сдвиг дальнего плана. */
  private fun loadSharp() {
    if (geometryKey.isEmpty() || width <= 0 || height <= 0) return
    val m = FloatArray(9)
    imageMatrix.getValues(m)
    val pad = ceil(farShift).toInt() + 2
    val geo = SharpGeometry(m[Matrix.MSCALE_X], m[Matrix.MTRANS_X], m[Matrix.MTRANS_Y], -pad, -pad, width + pad * 2, height + pad * 2)
    sharp = geo
    sharpLayers = SpatialScene.sharpLayers(context, geo) {
      if (sharp === geo) {
        sharpLayers = it
        invalidate()
      }
    }
    if (sharpLayers != null) invalidate()
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
      val geo = sharp
      val sl = sharpLayers
      val crisp = if (geo != null && sl != null) geo to sl else null
      s.draw(canvas, img, lay, pl, tl, crisp, imageMatrix, width, height, tiltX, tiltY, farShift, planeShift, blurPx)
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
    private val offX = FloatArray(5)
    private val offY = FloatArray(5)

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
      crisp: Pair<SharpGeometry, Bitmap>?,
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
      if (crisp != null) {
        // Пиксель в пиксель: сдвиги планов ниже — целые, выборка попадает точно в центры.
        val (geo, sharpLayers) = crisp
        localMatrix.setTranslate(geo.left.toFloat(), geo.top.toFloat())
        bind(1, "layers", sharpLayers, true, localMatrix)
      } else {
        bind(1, "layers", layers, true, imageMatrix)
      }
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
      val snap = crisp != null
      shader.setFloatUniform("plateOffset", tiltX * farShift, tiltY * farShift)
      for (k in planeShift.indices) {
        offX[k] = offset(tiltX * planeShift[k], snap)
        offY[k] = offset(tiltY * planeShift[k], snap)
      }
      shader.setFloatUniform("planeOffX", offX)
      shader.setFloatUniform("planeOffY", offY)
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

    private fun offset(v: Float, snap: Boolean): Float = if (snap) round(v) else v
  }

  internal companion object {
    /**
     * Сцены на экранах (главная, рандом-чат): одна общая ссылка не годилась — сцена второго
     * экрана забирала её, а закрываясь, обнуляла, и стекло главной становилось сплошным.
     */
    private val attachedScenes = ArrayList<SpatialBackgroundView>()

    /** Сцена под стеклянным блоком: та, что лежит на его экране (её родитель — его предок). */
    internal fun sceneUnder(view: View): SpatialBackgroundView? {
      for (i in attachedScenes.indices.reversed()) {
        val scene = attachedScenes[i]
        val root = scene.parent as? View ?: continue
        var p: android.view.ViewParent? = view.parent
        while (p != null) {
          if (p === root) return scene
          p = p.parent
        }
      }
      return attachedScenes.lastOrNull()
    }

    /** Сцена — Real-ESRGAN 1440 px (scripts/generate-spatial-depth.js): полное разрешение. */
    const val RES_DIVISOR = 1f
    /** Фон без элементов — дальше всех. */
    const val FAR_SHIFT_DP = 18f
    /**
     * Планы 1…5 (spatial_stage_planes.png) при полном наклоне: панели данных и соты, карта,
     * мелкие частицы, иконки и кубы, облако и крупное боке. Чем ближе к стеклу, тем меньше
     * сдвиг: между фоном и облаком ~42 px на A35. Интерфейс стоит на стекле, и объём держит
     * только сцена — разнос планов больше прежнего (14…2.5 dp), а кадр почти тот же: запас
     * cover вырос на 4 dp.
     */
    val PLANE_SHIFT_DP = floatArrayOf(15f, 12.5f, 9f, 5f, 2f)
    /** Пересчёт под экран — когда размер не менялся столько, мс. */
    const val SHARP_DELAY_MS = 250L
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
      uniform float2 plateOffset;
      uniform float planeOffX[5];
      uniform float planeOffY[5];
      uniform float4 imageRect;
      uniform float dim;
      layout(color) uniform half4 glowColor;

      half4 main(float2 p) {
        // Дальний план — фон без элементов.
        float3 c = float3(plate.eval(p - plateOffset).rgb);
        // Элементы: каждый план сдвигается целиком, без растяжения. Проверяются только планы,
        // что есть рядом (биты плитки); точка слоя — его, если номер плана совпал.
        float bits = floor(float(tiles.eval(p).r) * 255.0 / 8.0 + 0.5);
        float strongest = 0.0;
        float sheenShift = farShift;
        // Самый яркий элемент в точке: где он лежит в слое, его вклад и план (для голограммы).
        float2 qd = p;
        float3 dd = float3(0.0);
        float plane = 0.0;
        for (int k = 0; k < 5; k++) {
          if (mod(floor(bits / exp2(float(k))), 2.0) < 0.5) continue;
          float s = planeShift[k];
          float2 q = p - float2(planeOffX[k], planeOffY[k]);
          if (abs(float(planes.eval(q).r) * 255.0 / 40.0 - float(k + 1)) > 0.5) continue;
          float3 d = float3(layers.eval(q).rgb) - 64.0 / 255.0;
          c += d;
          float amount = d.r + d.g + d.b;
          if (amount > strongest) {
            strongest = amount;
            sheenShift = s;
            qd = q;
            dd = d;
            plane = float(k + 1);
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

        // Голограмма — только на элементах, пиксель в пиксель, без размытия. Рельеф элемента —
        // его же яркость в слое: соседи через 1 px на его плане дают наклон грани. Свет стоит
        // в мире и при наклоне телефона обходит контуры: грани к свету — тонкая ледяная кромка,
        // от света — чуть темнее и глубже в синий; где грань ровно отражает свет в глаз —
        // узкий блик, он бежит по краю. Строк развёртки нет: даже слабые читались полосами.
        // Только от наклона: в покое сцена не перерисовывается.
        if (strongest > 0.03) {
          const float3 W = float3(0.2126, 0.7152, 0.0722);
          float h0 = dot(dd, W);
          // Собель 3×3: соседи через 1 px — кромка в пиксель толщиной, а зерно картинки
          // (±1 уровень) вдоль края усредняется.
          float a00 = dot(float3(layers.eval(qd + float2(-1.0, -1.0)).rgb), W);
          float a10 = dot(float3(layers.eval(qd + float2(0.0, -1.0)).rgb), W);
          float a20 = dot(float3(layers.eval(qd + float2(1.0, -1.0)).rgb), W);
          float a01 = dot(float3(layers.eval(qd + float2(-1.0, 0.0)).rgb), W);
          float a21 = dot(float3(layers.eval(qd + float2(1.0, 0.0)).rgb), W);
          float a02 = dot(float3(layers.eval(qd + float2(-1.0, 1.0)).rgb), W);
          float a12 = dot(float3(layers.eval(qd + float2(0.0, 1.0)).rgb), W);
          float a22 = dot(float3(layers.eval(qd + float2(1.0, 1.0)).rgb), W);
          // Наклон грани — относительно яркости самого элемента: тусклая иконка с мягким краем
          // и яркая линия карты получают кромку одной толщины.
          float2 g = float2(a20 + 2.0 * a21 + a22 - a00 - 2.0 * a01 - a02, a02 + 2.0 * a12 + a22 - a00 - 2.0 * a10 - a20) / (8.0 * max(h0, 0.04));
          float slope = length(g);
          // Сила — от яркости самого элемента: слабые ореолы и дымка голограммы не получают.
          float body = smoothstep(0.012, 0.06, h0);
          // Порог — выше зерна картинки: кромка только по настоящим краям, без сыпи искр по
          // телу иконки.
          float edge = smoothstep(0.1, 0.32, slope) * body;
          float3 N = normalize(float3(-g * 2.5, 1.0));
          float3 L = normalize(float3(-0.45 - tilt.x * 0.9, -0.65 - tilt.y * 0.9, 0.62));
          float lit = dot(N, L) - L.z;
          float3 H = normalize(L + float3(0.0, 0.0, 1.0));
          float glint = max(0.0, pow(max(dot(N, H), 0.0), 48.0) - pow(H.z, 48.0));
          // Иконки, кубы, облако (планы 4–5) — голограмма целиком; карта, цифры, частицы —
          // только кромка слабее и блик: тень с дальней стороны тонкую линию гасила бы.
          float icon = plane > 3.5 ? 1.0 : 0.0;
          // Оттенок кромки — дифракция в голубой гамме: меняется вдоль контура, по экрану и с
          // наклоном, без сирени.
          float2 hq = qd / size.x;
          float2 nxy = N.xy / max(length(N.xy), 1e-4);
          float t = 0.5 + 0.5 * sin(6.2831853 * (dot(hq, float2(0.62, 0.78)) * 1.6 + dot(tilt, float2(0.7, 0.45)) * 0.8) + 1.6 * dot(nxy, float2(0.8, -0.6)));
          float3 cobalt = float3(0.30, 0.50, 1.0);
          float3 iceRim = float3(0.62, 0.90, 1.0);
          float3 rim = mix(float3(glowColor.rgb), iceRim, t);
          // Контур светится и сам по себе, ровно по кругу, — как у проекции; к свету — ярче.
          c += rim * (edge * (max(0.0, lit) * mix(0.09, 0.18, icon) + 0.045 * icon));
          c = mix(c, c * cobalt, edge * min(1.0, max(0.0, -lit)) * 0.3 * icon);
          c += float3(0.86, 0.96, 1.0) * (glint * edge * 0.4);
        }

        // Blue noise ±0.5 уровня до округления: тёмные переходы без полос.
        c += (float(noise.eval(p).r) - 0.5) / 255.0;
        return half4(half3(c), 1.0);
      }
    """
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
  /** Блик сверху; без него блок одного тона сверху донизу (высокие карточки рандом-чата). */
  private var sheen = true
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

  fun setSheen(value: Boolean) {
    sheen = value
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
    val scene = SpatialBackgroundView.sceneUnder(this) ?: return
    sceneOffset(scene)
    val shift = scene.glassShift
    val ox = sceneLoc[0] - selfLoc[0] + scene.drawnTiltX * shift
    val oy = sceneLoc[1] - selfLoc[1] + scene.drawnTiltY * shift
    if (drawnX.isNaN() || abs(ox - drawnX) >= STICKY_PX || abs(oy - drawnY) >= STICKY_PX) invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    rect.set(0f, 0f, w, h)
    val scene = SpatialBackgroundView.sceneUnder(this)?.takeIf { it.isAttachedToWindow }
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
    val ox = sceneLoc[0] - selfLoc[0] + scene.drawnTiltX * shift
    val oy = sceneLoc[1] - selfLoc[1] + scene.drawnTiltY * shift
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
    if (sheen) {
      if (sheenHeight != h) {
        sheenHeight = h
        sheenPaint.shader =
          LinearGradient(0f, 0f, 0f, h * 0.55f, Color.argb(16, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
      }
      canvas.drawRoundRect(rect, radius, radius, sheenPaint)
    }
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

class SpatialGlassViewManager : SimpleViewManager<SpatialGlassView>() {
  override fun getName(): String = "LiviSpatialGlass"

  override fun createViewInstance(context: ThemedReactContext): SpatialGlassView = SpatialGlassView(context)

  @ReactProp(name = "radius", defaultFloat = 0f)
  fun setRadius(view: SpatialGlassView, value: Float) = view.setRadiusDp(value)

  @ReactProp(name = "tint", customType = "Color", defaultInt = Color.TRANSPARENT)
  fun setTint(view: SpatialGlassView, value: Int) = view.setTint(value)

  @ReactProp(name = "fallbackColor", customType = "Color", defaultInt = Color.TRANSPARENT)
  fun setFallbackColor(view: SpatialGlassView, value: Int) = view.setFallback(value)

  @ReactProp(name = "sheen", defaultBoolean = true)
  fun setSheen(view: SpatialGlassView, value: Boolean) = view.setSheen(value)
}
