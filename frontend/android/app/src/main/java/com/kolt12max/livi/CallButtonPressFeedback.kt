package com.kolt12max.livi

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.ImageButton
import androidx.annotation.ColorInt
import androidx.core.graphics.ColorUtils
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min

/** A soft circular light wave grows outwards from the button border. */
internal class CallButtonPressFeedback private constructor(
    private val button: ImageButton,
    private val root: ViewGroup,
    @ColorInt private val color: Int,
) : View.OnTouchListener, View.OnAttachStateChangeListener {
    private var wave: BorderWave? = null
    private var animator: ValueAnimator? = null

    override fun onTouch(view: View, event: MotionEvent): Boolean {
        if (!view.isEnabled) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startWave()
                animatePress(true)
            }
            MotionEvent.ACTION_UP -> animatePress(false)
            MotionEvent.ACTION_CANCEL -> {
                clearWave()
                animatePress(false)
            }
        }
        // Keep normal click handling and call actions immediate.
        return false
    }

    private fun animatePress(pressed: Boolean) {
        val scale = if (pressed) 0.94f else 1f
        button.animate()
            .scaleX(scale)
            .scaleY(scale)
            .setDuration(if (pressed) 90L else 160L)
            .start()
    }

    private fun startWave() {
        clearWave()
        if (!button.isAttachedToWindow || button.width == 0 || root.width == 0) return
        val buttonPosition = IntArray(2)
        val rootPosition = IntArray(2)
        button.getLocationInWindow(buttonPosition)
        root.getLocationInWindow(rootPosition)
        val density = button.resources.displayMetrics.density
        val centerX = buttonPosition[0] - rootPosition[0] + button.width * button.scaleX / 2f
        val centerY = buttonPosition[1] - rootPosition[1] + button.height * button.scaleY / 2f
        val radius = min(button.width * button.scaleX, button.height * button.scaleY) / 2f
        val ring = BorderWave(
            centerX = centerX,
            centerY = centerY,
            startRadius = radius,
            density = density,
            color = color,
        )
        // Invalidate only the area around this button, not the entire call screen.
        val extent = (radius + 42f * density) / 0.95f + density
        ring.setBounds(
            floor(centerX - extent).toInt(), floor(centerY - extent).toInt(),
            ceil(centerX + extent).toInt(), ceil(centerY + extent).toInt(),
        )
        wave = ring
        // The screen overlay avoids clipping at the 64dp button or its bottom row.
        root.overlay.add(ring)
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1100L
            // Keep time linear so the fade does not disappear as quickly as the expanding edge.
            interpolator = LinearInterpolator()
            addUpdateListener {
                ring.progress = it.animatedValue as Float
                ring.invalidateSelf()
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    clearWave()
                }
            })
        }
        animator?.start()
    }

    private fun clearWave() {
        animator?.removeAllListeners()
        animator?.cancel()
        animator = null
        wave?.let { root.overlay.remove(it) }
        wave = null
    }

    override fun onViewAttachedToWindow(view: View) = Unit

    override fun onViewDetachedFromWindow(view: View) {
        clearWave()
        button.animate().cancel()
        button.scaleX = 1f
        button.scaleY = 1f
    }

    private class BorderWave(
        private val centerX: Float,
        private val centerY: Float,
        private val startRadius: Float,
        private val density: Float,
        @ColorInt color: Int,
    ) : Drawable() {
        private val glowColor = FloatArray(3).let { hsv ->
            Color.colorToHSV(color, hsv)
            hsv[1] = (hsv[1] * 1.25f).coerceAtMost(0.8f)
            hsv[2] = hsv[2].coerceAtLeast(0.9f)
            Color.HSVToColor(hsv)
        }
        private val highlightColor = ColorUtils.blendARGB(glowColor, Color.WHITE, 0.25f)
        private val shaderMatrix = Matrix()
        // Build the light profile once. Only its transform and overall opacity change per frame.
        private val gradient = RadialGradient(
            0f, 0f, 1f,
            intArrayOf(
                ColorUtils.setAlphaComponent(glowColor, 0),
                ColorUtils.setAlphaComponent(glowColor, 0),
                ColorUtils.setAlphaComponent(glowColor, 14),
                ColorUtils.setAlphaComponent(glowColor, 42),
                ColorUtils.setAlphaComponent(glowColor, 88),
                ColorUtils.setAlphaComponent(highlightColor, 112),
                ColorUtils.setAlphaComponent(glowColor, 38),
                ColorUtils.setAlphaComponent(glowColor, 0),
            ),
            floatArrayOf(0f, 0.52f, 0.72f, 0.85f, 0.92f, 0.95f, 0.975f, 1f),
            Shader.TileMode.CLAMP,
        )
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = gradient
        }
        private val wavePath = Path()
        private var drawableAlpha = 255
        var progress = 0f

        override fun draw(canvas: Canvas) {
            val distance = 1f - (1f - progress) * (1f - progress)
            val outerRadius = (startRadius + 42f * density * distance) / 0.95f
            val fade = ((progress - 0.15f) / 0.85f).coerceIn(0f, 1f)
            val opacity = 1f - fade * fade * (3f - 2f * fade)
            paint.alpha = (opacity * drawableAlpha).toInt()
            shaderMatrix.setScale(outerRadius, outerRadius)
            shaderMatrix.postTranslate(centerX, centerY)
            gradient.setLocalMatrix(shaderMatrix)

            // Leave the button untouched: the coloured tail illuminates only the area outside its rim.
            wavePath.rewind()
            wavePath.addCircle(centerX, centerY, outerRadius, Path.Direction.CW)
            wavePath.addCircle(centerX, centerY, startRadius, Path.Direction.CCW)
            canvas.drawPath(wavePath, paint)
        }

        override fun setAlpha(alpha: Int) {
            drawableAlpha = alpha
            invalidateSelf()
        }

        override fun setColorFilter(colorFilter: ColorFilter?) {
            paint.colorFilter = colorFilter
            invalidateSelf()
        }

        @Suppress("DEPRECATION")
        override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
    }

    companion object {
        fun install(button: ImageButton, root: ViewGroup, @ColorInt color: Int) {
            val feedback = CallButtonPressFeedback(button, root, color)
            button.setOnTouchListener(feedback)
            button.addOnAttachStateChangeListener(feedback)
        }
    }
}
