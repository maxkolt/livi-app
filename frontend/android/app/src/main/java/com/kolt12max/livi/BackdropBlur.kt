package com.kolt12max.livi

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewTreeObserver
import android.widget.ScrollView
import androidx.annotation.RequiresApi
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager
import java.lang.ref.WeakReference

/**
 * Стекло шапки и композера чата без программной перерисовки окна.
 *
 * expo-blur (Dimezis 2) на каждом кадре рисовал всё окно в bitmap на CPU — отдельно для шапки
 * и для композера — и грузил его в GPU. При прокрутке ленты это 13+ мс UI-потока и ~5 мс GPU
 * на кадр: Galaxy A35 держал ~75 fps вместо 120, экранам 144–165 Гц не хватало ещё больше.
 *
 * Здесь [BlurSourceView] пишет своих детей в RenderNode, а [BlurBackdropView] рисует те же
 * RenderNode: фон и обои — как есть, ленту — под RenderEffect-размытием. Дети не
 * перерисовываются, GPU берёт уже записанные списки. Нужен Android 12 (RenderEffect).
 */
object BackdropBlur {
  private val sources = HashMap<String, WeakReference<BlurSourceView>>()

  internal fun register(id: String, view: BlurSourceView) {
    sources[id] = WeakReference(view)
  }

  internal fun unregister(id: String, view: BlurSourceView) {
    if (sources[id]?.get() === view) sources.remove(id)
  }

  internal fun find(id: String): BlurSourceView? =
    sources[id]?.get()?.takeIf { it.isAttachedToWindow }

  /**
   * Радиус expo-blur (Dimezis: размытие на bitmap в 1/6 экрана) → радиус на полном разрешении
   * с той же сигмой. HWUI: sigma = 0.57735 · radius + 0.5.
   */
  internal fun fullResRadius(dimezisRadius: Float): Float {
    if (dimezisRadius <= 0f) return 0f
    val sigma = DIMEZIS_SCALE * (RADIUS_TO_SIGMA * dimezisRadius + 0.5f)
    return (sigma - 0.5f) / RADIUS_TO_SIGMA
  }

  private const val DIMEZIS_SCALE = 6f
  private const val RADIUS_TO_SIGMA = 0.57735f
}

/**
 * Источник для [BlurBackdropView]; заодно растворяет края ленты под шапкой и над композером.
 *
 * Растворение раньше делал MaskedView: HW-слой на всю ленту, а в захвате Dimezis — программный
 * кэш во весь экран (~30 мс на кадр). Здесь offscreen-слой только у полос fadeTop/fadeBottom.
 */
class BlurSourceView(context: Context) : ReactViewGroup(context) {
  private var sourceId: String? = null
  private var fadeTop = 0f
  private var fadeBottom = 0f
  private val topPaint = fadePaint()
  private val bottomPaint = fadePaint()
  private var shaderH = -1f
  private var shaderTop = -1f
  private var shaderBottom = -1f
  private var nodes: Any? = null

  @RequiresApi(Build.VERSION_CODES.Q)
  private class Nodes {
    val content = RenderNode("LiviBlurSource")
    val faded = RenderNode("LiviBlurSourceFaded")
    var output: RenderNode? = null
  }

  /** То, что источник показывает на экране; null до первой аппаратной записи. */
  internal val output: RenderNode?
    @RequiresApi(Build.VERSION_CODES.Q)
    get() = (nodes as? Nodes)?.output?.takeIf { it.hasDisplayList() }

  fun setSourceId(id: String?) {
    if (id == sourceId) return
    sourceId?.let { BackdropBlur.unregister(it, this) }
    sourceId = id
    if (isAttachedToWindow && id != null) BackdropBlur.register(id, this)
  }

  fun setFadeTopDp(value: Float) {
    fadeTop = PixelUtil.toPixelFromDIP(value)
    invalidate()
  }

  fun setFadeBottomDp(value: Float) {
    fadeBottom = PixelUtil.toPixelFromDIP(value)
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    sourceId?.let { BackdropBlur.register(it, this) }
    for (i in 0 until childCount) requestPeakFrameRate(getChildAt(i))
  }

  override fun onDetachedFromWindow() {
    sourceId?.let { BackdropBlur.unregister(it, this) }
    super.onDetachedFromWindow()
  }

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    requestPeakFrameRate(child)
  }

  /**
   * Прокрутка ленты — на пиковой частоте экрана, в том числе 144/165 Гц, а не на категории
   * HIGH (у A35 это 90 Гц). Запрос действует, только пока лента перерисовывается: в покое
   * экран снижает частоту как обычно. Android 15+; где система его не учитывает — no-op.
   */
  private fun requestPeakFrameRate(child: View) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM || child !is ScrollView) return
    val d = display ?: return
    val mode = d.mode
    val peak =
      d.supportedModes
        .filter { it.physicalWidth == mode.physicalWidth && it.physicalHeight == mode.physicalHeight }
        .maxOfOrNull { it.refreshRate } ?: return
    child.setRequestedFrameRate(peak)
  }

  override fun dispatchDraw(canvas: Canvas) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && canvas.isHardwareAccelerated) {
      drawRecorded(canvas)
    } else {
      drawDirect(canvas)
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun drawRecorded(canvas: Canvas) {
    val w = width
    val h = height
    val n = (nodes as? Nodes) ?: Nodes().also { nodes = it }
    val previous = n.output?.takeIf { it.hasDisplayList() }

    n.content.setPosition(0, 0, w, h)
    val rc = n.content.beginRecording(w, h)
    try {
      super.dispatchDraw(rc)
    } finally {
      n.content.endRecording()
    }

    val top = bandTop(h)
    val bottom = bandBottom(h)
    if (top <= 0f && bottom <= 0f) {
      n.output = n.content
    } else {
      updateShaders(h.toFloat(), top, bottom)
      n.faded.setPosition(0, 0, w, h)
      val fc = n.faded.beginRecording(w, h)
      try {
        val fw = w.toFloat()
        val fh = h.toFloat()
        if (fh - bottom > top) {
          val s = fc.save()
          fc.clipRect(0f, top, fw, fh - bottom)
          fc.drawRenderNode(n.content)
          fc.restoreToCount(s)
        }
        if (top > 0f) drawBand(fc, n.content, 0f, top, fw, topPaint)
        if (bottom > 0f) drawBand(fc, n.content, fh - bottom, fh, fw, bottomPaint)
      } finally {
        n.faded.endRecording()
      }
      n.output = n.faded
    }
    canvas.drawRenderNode(n.output!!)

    // Стекло сверяет источники перед кадром; первую запись (и смену узла) оно увидит
    // только в следующем кадре — запрашиваем его.
    if (previous !== n.output) postInvalidateOnAnimation()
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun drawBand(c: Canvas, content: RenderNode, y0: Float, y1: Float, w: Float, paint: Paint) {
    val s = c.save()
    c.clipRect(0f, y0, w, y1)
    // Слой размером с полосу (границы — текущий клип).
    c.saveLayer(null, null)
    c.drawRenderNode(content)
    c.drawRect(0f, y0, w, y1, paint)
    c.restoreToCount(s)
  }

  /** Программный canvas: снимки экрана и захват Dimezis на Android 10–11. */
  private fun drawDirect(canvas: Canvas) {
    val h = height
    val top = bandTop(h)
    val bottom = bandBottom(h)
    if (top <= 0f && bottom <= 0f) {
      super.dispatchDraw(canvas)
      return
    }
    updateShaders(h.toFloat(), top, bottom)
    // Слой в пределах клипа canvas: в захвате Dimezis это только полоса под стеклом.
    val s = canvas.saveLayer(null, null)
    super.dispatchDraw(canvas)
    val w = width.toFloat()
    if (top > 0f) canvas.drawRect(0f, 0f, w, top, topPaint)
    if (bottom > 0f) canvas.drawRect(0f, h - bottom, w, h.toFloat(), bottomPaint)
    canvas.restoreToCount(s)
  }

  private fun bandTop(h: Int): Float = fadeTop.coerceIn(0f, h.toFloat())

  private fun bandBottom(h: Int): Float = fadeBottom.coerceIn(0f, h - bandTop(h))

  private fun updateShaders(h: Float, top: Float, bottom: Float) {
    if (h == shaderH && top == shaderTop && bottom == shaderBottom) return
    shaderH = h
    shaderTop = top
    shaderBottom = bottom
    topPaint.shader =
      if (top > 0f) LinearGradient(0f, 0f, 0f, top, Color.TRANSPARENT, Color.BLACK, Shader.TileMode.CLAMP)
      else null
    bottomPaint.shader =
      if (bottom > 0f) LinearGradient(0f, h - bottom, 0f, h, Color.BLACK, Color.TRANSPARENT, Shader.TileMode.CLAMP)
      else null
  }

  private companion object {
    fun fadePaint() = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) }
  }
}

/**
 * Стекло: фон окна и [backgroundSources] (основной фон, обои) — без размытия, поверх
 * [blurSources] (лента) под размытием, затем матовая подложка и градиент chrome. Dimezis
 * захватывал их вместе с окном и размывал — затемнение под стеклом то же, что было.
 */
class BlurBackdropView(context: Context) : View(context) {
  private var backgroundSources: List<String> = emptyList()
  private var blurSources: List<String> = emptyList()
  private var radius = 0f
  private var overlayColor = Color.TRANSPARENT
  private var matteColor = Color.TRANSPARENT
  private var fadeColors: IntArray? = null
  private var fadeStops: FloatArray? = null
  private var mirror = false
  private val fadePaint = Paint()
  private var fadeShaderH = -1
  private var fadeDirty = true
  private var node: Any? = null
  private var nodeRadius = -1f
  private val selfLoc = IntArray(2)
  private val srcLoc = IntArray(2)
  private var drawnState = 0L

  private val preDraw =
    ViewTreeObserver.OnPreDrawListener {
      // Содержимое источников подтягивается само (узлы те же); перезаписываемся,
      // только когда сдвинулись мы или источник либо сменился его узел.
      if (sourceState() != drawnState) invalidate()
      true
    }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setBackgroundSources(ids: ReadableArray?) {
    backgroundSources = ids.toStringList()
    invalidate()
  }

  fun setBlurSources(ids: ReadableArray?) {
    blurSources = ids.toStringList()
    invalidate()
  }

  fun setDimezisRadius(value: Float) {
    radius = BackdropBlur.fullResRadius(value)
    invalidate()
  }

  fun setOverlay(color: Int) {
    overlayColor = color
    invalidate()
  }

  fun setMatte(color: Int) {
    matteColor = color
    invalidate()
  }

  fun setFadeColors(colors: ReadableArray?) {
    fadeColors = colors?.let { a -> IntArray(a.size()) { a.getDouble(it).toLong().toInt() } }
    fadeDirty = true
    invalidate()
  }

  fun setFadeLocations(stops: ReadableArray?) {
    fadeStops = stops?.let { a -> FloatArray(a.size()) { a.getDouble(it).toFloat() } }
    fadeDirty = true
    invalidate()
  }

  fun setMirror(value: Boolean) {
    mirror = value
    fadeDirty = true
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(preDraw)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDraw)
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width
    val h = height
    if (w <= 0 || h <= 0) return
    getLocationInWindow(selfLoc)
    // Фон окна — на случай, если фонового источника нет.
    rootView.background?.let { bg ->
      val s = canvas.save()
      canvas.translate(-selfLoc[0].toFloat(), -selfLoc[1].toFloat())
      bg.draw(canvas)
      canvas.restoreToCount(s)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && canvas.isHardwareAccelerated) {
      drawSources(canvas, backgroundSources)
      drawBlurred(canvas, w, h)
    }
    if (matteColor != Color.TRANSPARENT) canvas.drawColor(matteColor)
    if (updateFade(h)) canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), fadePaint)
    if (overlayColor != Color.TRANSPARENT) canvas.drawColor(overlayColor)
    drawnState = sourceState()
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun drawBlurred(canvas: Canvas, w: Int, h: Int) {
    val n = (node as? RenderNode) ?: RenderNode("LiviBlurBackdrop").also { node = it }
    n.setPosition(0, 0, w, h)
    if (nodeRadius != radius) {
      n.setRenderEffect(
        if (radius > 0f) RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.MIRROR) else null,
      )
      nodeRadius = radius
    }
    val rc = n.beginRecording(w, h)
    try {
      drawSources(rc, blurSources)
    } finally {
      n.endRecording()
    }
    canvas.drawRenderNode(n)
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun drawSources(canvas: Canvas, ids: List<String>) {
    for (id in ids) {
      val src = BackdropBlur.find(id) ?: continue
      val out = src.output ?: continue
      src.getLocationInWindow(srcLoc)
      val s = canvas.save()
      canvas.translate((srcLoc[0] - selfLoc[0]).toFloat(), (srcLoc[1] - selfLoc[1]).toFloat())
      canvas.drawRenderNode(out)
      canvas.restoreToCount(s)
    }
  }

  private fun updateFade(h: Int): Boolean {
    val colors = fadeColors
    if (colors == null || colors.size < 2) return false
    if (fadeDirty || fadeShaderH != h) {
      val stops = fadeStops?.takeIf { it.size == colors.size }
      val y0 = if (mirror) h.toFloat() else 0f
      val y1 = if (mirror) 0f else h.toFloat()
      fadePaint.shader = LinearGradient(0f, y0, 0f, y1, colors, stops, Shader.TileMode.CLAMP)
      fadeShaderH = h
      fadeDirty = false
    }
    return true
  }

  /** Положение стекла и источников + их узлы: изменилось — перезаписываем стекло. */
  private fun sourceState(): Long {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0L
    getLocationInWindow(selfLoc)
    var state = selfLoc[0].toLong() * 31 + selfLoc[1]
    for (ids in arrayOf(backgroundSources, blurSources)) {
      for (id in ids) {
        val src = BackdropBlur.find(id)
        state = state * 31 + System.identityHashCode(src?.output)
        if (src != null) {
          src.getLocationInWindow(srcLoc)
          state = (state * 31 + srcLoc[0]) * 31 + srcLoc[1]
        }
      }
    }
    return state
  }

  private fun ReadableArray?.toStringList(): List<String> =
    if (this == null) emptyList() else (0 until size()).mapNotNull { getString(it) }
}

class BlurSourceViewManager : ReactViewManager() {
  override fun getName(): String = "LiviBlurSource"

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = BlurSourceView(context)

  @ReactProp(name = "sourceId")
  fun setSourceId(view: ReactViewGroup, value: String?) = (view as BlurSourceView).setSourceId(value)

  @ReactProp(name = "fadeTop", defaultFloat = 0f)
  fun setFadeTop(view: ReactViewGroup, value: Float) = (view as BlurSourceView).setFadeTopDp(value)

  @ReactProp(name = "fadeBottom", defaultFloat = 0f)
  fun setFadeBottom(view: ReactViewGroup, value: Float) = (view as BlurSourceView).setFadeBottomDp(value)
}

class BlurBackdropViewManager : SimpleViewManager<BlurBackdropView>() {
  override fun getName(): String = "LiviBlurBackdrop"

  override fun createViewInstance(context: ThemedReactContext): BlurBackdropView = BlurBackdropView(context)

  @ReactProp(name = "backgroundSources")
  fun setBackgroundSources(view: BlurBackdropView, value: ReadableArray?) = view.setBackgroundSources(value)

  @ReactProp(name = "blurSources")
  fun setBlurSources(view: BlurBackdropView, value: ReadableArray?) = view.setBlurSources(value)

  /** Радиус в единицах expo-blur на Android: intensity / blurReductionFactor. */
  @ReactProp(name = "blurRadius", defaultFloat = 0f)
  fun setBlurRadius(view: BlurBackdropView, value: Float) = view.setDimezisRadius(value)

  @ReactProp(name = "overlayColor", customType = "Color", defaultInt = Color.TRANSPARENT)
  fun setOverlayColor(view: BlurBackdropView, value: Int) = view.setOverlay(value)

  @ReactProp(name = "matteColor", customType = "Color", defaultInt = Color.TRANSPARENT)
  fun setMatteColor(view: BlurBackdropView, value: Int) = view.setMatte(value)

  @ReactProp(name = "fadeColors", customType = "ColorArray")
  fun setFadeColors(view: BlurBackdropView, value: ReadableArray?) = view.setFadeColors(value)

  @ReactProp(name = "fadeLocations")
  fun setFadeLocations(view: BlurBackdropView, value: ReadableArray?) = view.setFadeLocations(value)

  @ReactProp(name = "mirror", defaultBoolean = false)
  fun setMirror(view: BlurBackdropView, value: Boolean) = view.setMirror(value)
}
