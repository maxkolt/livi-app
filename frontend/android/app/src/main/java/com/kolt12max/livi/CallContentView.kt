package com.kolt12max.livi

import android.graphics.Canvas
import android.view.View
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager
import com.swmansion.rnscreens.Screen
import com.swmansion.rnscreens.ScreenStack

/** A layout/attachment acknowledgement is earlier than a native-stack screen's draw. */
internal class CallContentView(context: ThemedReactContext) : ReactViewGroup(context) {
  var callId: String? = null

  fun isTopCallContent(): Boolean {
    if (!isAttachedToWindow || !isShown || width <= 0 || height <= 0) return false
    var ancestor: View? = this
    var screen: Screen? = null
    while (ancestor != null) {
      if (ancestor.visibility != View.VISIBLE || ancestor.alpha < 0.99f) return false
      if (ancestor is Screen) screen = ancestor
      if (ancestor is ScreenStack) return screen != null && ancestor.topScreen === screen
      ancestor = ancestor.parent as? View
    }
    return false
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    // Android native-stack must actually draw this subtree, not just measure it.
    if (canvas.isHardwareAccelerated && isTopCallContent()) {
      MainActivity.onIncomingCallContentDrawn(callId, this)
    }
    // A fragment can become top after its child display list was recorded.
    // Keep requesting real draws only while this call's handoff is pending.
    if (MainActivity.isWaitingForIncomingCallContent(callId)) postInvalidateOnAnimation()
  }
}

class CallContentViewManager : ReactViewManager() {
  override fun getName(): String = "LiviCallContent"
  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = CallContentView(context)

  @ReactProp(name = "callId")
  fun setCallId(view: ReactViewGroup, value: String?) {
    (view as CallContentView).callId = value?.trim()?.takeIf { it.isNotEmpty() }
    view.invalidate()
  }
}
