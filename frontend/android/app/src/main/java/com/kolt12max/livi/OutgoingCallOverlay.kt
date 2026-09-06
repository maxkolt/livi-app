package com.kolt12max.livi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
/**
 * Исходящий UI поверх MainActivity (без второй Activity).
 * Main не уходит в onPause → RN/таймеры/тачи не «спят» 3–6с после X.
 * OutgoingCallActivity остаётся для фона / lock screen / cold start.
 */
object OutgoingCallOverlay {
  private const val TAG = "OutgoingCallOverlay"

  @JvmField
  @Volatile
  var isVisible: Boolean = false

  private var host: MainActivity? = null
  private var root: View? = null
  private var callId: String = ""
  private var toUserId: String = ""
  private var toNick: String = ""
  private var hasVideo: Boolean = true
  private var closeReceiver: BroadcastReceiver? = null
  private var callIdReadyReceiver: BroadcastReceiver? = null
  private val handler = Handler(Looper.getMainLooper())
  private var dotsRunnable: Runnable? = null
  private var callIdEmptyTimeoutRunnable: Runnable? = null
  private var dotsCount = 0
  private var hideRequested = false

  private var pendingProvisionalId: String? = null
  /** Поколение отложенного silenceAndStop — redial инвалидирует stop старого dial. */
  private var stopGeneration: Int = 0
  private var deferredStopRunnable: Runnable? = null

  private fun cancelDeferredRingbackStop() {
    deferredStopRunnable?.let { handler.removeCallbacks(it) }
    deferredStopRunnable = null
    stopGeneration += 1
  }

  private fun scheduleDeferredRingbackStop(ctx: Context, idToStop: String) {
    val gen = stopGeneration
    val id = idToStop
    val runnable = Runnable {
      deferredStopRunnable = null
      if (gen != stopGeneration) {
        Log.d(TAG, "deferred silenceAndStop skipped (stale gen) id=${id.take(24)}")
        return@Runnable
      }
      LiviOutgoingCallService.silenceAndStop(ctx, id)
    }
    deferredStopRunnable = runnable
    handler.postDelayed(runnable, 1800L)
  }

  /** @return true если показали оверлей на живом Main (Activity не нужна). */
  @JvmStatic
  fun tryShowOnForegroundMain(toUserId: String, toNick: String, hasVideo: Boolean): Boolean {
    val act = MainActivity.lastResumedInstance
    if (act == null || !MainActivity.isInForeground || act.isFinishing || act.isDestroyed) {
      return false
    }
    // Redial: не дать silenceAndStop прошлого X заглушить новый ringback / CLOSE.
    cancelDeferredRingbackStop()
    // Ringback синхронно до return: иначе notifyOutgoingCallId обгоняет UI-thread show.
    val provisionalId = "pending_${System.currentTimeMillis()}"
    pendingProvisionalId = provisionalId
    this.toUserId = toUserId
    this.toNick = toNick
    this.hasVideo = hasVideo
    callId = provisionalId
    try {
      LiviOngoingCallHelper.setOutgoingCall(act, provisionalId, toUserId, toNick)
      LiviOutgoingCallService.start(act, provisionalId, toUserId, toNick)
    } catch (e: Exception) {
      Log.w(TAG, "tryShow: provisional ringback start failed", e)
    }
    act.runOnUiThread {
      showInternal(act, toUserId, toNick, hasVideo, provisionalAlreadyStarted = true)
    }
    return true
  }

  @JvmStatic
  fun hide(stopRingback: Boolean = true) {
    val act = host ?: MainActivity.lastResumedInstance
    if (act != null && !act.isFinishing && !act.isDestroyed) {
      act.runOnUiThread { hideInternal(act, stopRingback) }
    } else {
      hideInternal(null, stopRingback)
    }
  }

  @JvmStatic
  fun bindCallId(newCallId: String) {
    val id = newCallId.trim()
    if (id.isEmpty()) return
    handler.post {
      if (!isVisible) return@post
      val prev = callId
      callId = id
      callIdEmptyTimeoutRunnable?.let { handler.removeCallbacks(it) }
      callIdEmptyTimeoutRunnable = null
      val ctx = host ?: return@post
      LiviOngoingCallHelper.setOutgoingCall(ctx, id, toUserId, toNick)
      if (!LiviOutgoingCallService.adoptRealCallId(ctx, id, toUserId, toNick)) {
        if (prev.startsWith("pending_")) {
          LiviOutgoingCallService.stop(ctx, prev)
        }
        LiviOutgoingCallService.start(ctx, id, toUserId, toNick)
      }
    }
  }

  private fun showInternal(
    activity: MainActivity,
    toUserId: String,
    toNick: String,
    hasVideo: Boolean,
    provisionalAlreadyStarted: Boolean = false,
  ) {
    hideRequested = false
    this.toUserId = toUserId
    this.toNick = toNick
    this.hasVideo = hasVideo
    host = activity

    val decor = activity.window?.decorView as? ViewGroup ?: return
    val existing = root
    if (existing != null && existing.parent != null) {
      Log.d(TAG, "showInternal: reuse overlay nick=${toNick.take(20)}")
      bindUi(existing, toNick, hasVideo)
      existing.findViewById<View>(R.id.outgoing_call_content)?.let { content ->
        EdgeToEdgeHelper.applySystemBarInsetsFromWindow(content, decor)
      }
      if (provisionalAlreadyStarted) {
        attachCallIdReceiver(activity)
      } else {
        restartProvisionalRingback(activity)
      }
      isVisible = true
      existing.visibility = View.VISIBLE
      existing.bringToFront()
      return
    }

    val inflated = activity.layoutInflater.inflate(R.layout.activity_outgoing_call, decor, false)
    root = inflated
    bindUi(inflated, toNick, hasVideo)
    wireCancel(inflated)
    decor.addView(
      inflated,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    // Insets с decor (не dispatched child): status→ник и nav→X как у IncomingCallActivity.
    inflated.findViewById<View>(R.id.outgoing_call_content)?.let { content ->
      EdgeToEdgeHelper.applySystemBarInsetsFromWindow(content, decor)
    }
    inflated.elevation = 25000f
    inflated.translationZ = 25000f
    isVisible = true
    registerReceivers(activity)
    if (provisionalAlreadyStarted) {
      attachCallIdReceiver(activity)
      scheduleEmptyCallIdTimeout()
    } else {
      restartProvisionalRingback(activity)
    }
    Log.d(TAG, "showInternal: overlay added nick=${toNick.take(20)}")
  }

  private fun bindUi(rootView: View, nick: String, video: Boolean) {
    rootView.findViewById<TextView>(R.id.callee_name)?.text =
      if (nick.isNotEmpty()) nick else rootView.context.getString(R.string.outgoing_call_title)
    val subtitle = rootView.findViewById<TextView>(R.id.call_subtitle) ?: return
    startDotsAnimation(subtitle, video)
  }

  private fun wireCancel(rootView: View) {
    val cancelButton = rootView.findViewById<ImageButton>(R.id.btn_cancel) ?: return
    installPressFeedback(cancelButton)
    cancelButton.setOnClickListener {
      if (hideRequested) return@setOnClickListener
      hideRequested = true
      val effectiveCallId = callId
      LiviAppModule.emitOutgoingCallCanceledByUser(
        if (effectiveCallId.startsWith("pending_")) "" else effectiveCallId,
      )
      if (effectiveCallId.isNotEmpty() && !effectiveCallId.startsWith("pending_")) {
        LiviOutgoingCallService.cancelCallOnServer(rootView.context, effectiveCallId)
      }
      // Сначала убрать оверлей (тачи Main сразу). Mute сейчас, stop FGS — позже:
      // иначе stopForeground/broadcast CLOSE на том же кадре жрёт UI 1–2с.
      val ctx = rootView.context.applicationContext
      val idToStop = effectiveCallId
      hideInternal(host, stopRingback = false)
      try {
        LiviOutgoingCallService.silencePlayerOnly()
      } catch (_: Exception) {}
      scheduleDeferredRingbackStop(ctx, idToStop)
    }
  }

  private fun attachCallIdReceiver(activity: MainActivity) {
    callIdReadyReceiver?.let {
      try { activity.unregisterReceiver(it) } catch (_: Exception) {}
    }
    callIdReadyReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val id = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: return
        if (id.isEmpty() || !isVisible) return
        Log.d(TAG, "CALL_ID_READY: ${id.take(24)}")
        bindCallId(id)
        callIdReadyReceiver?.let {
          try { host?.unregisterReceiver(it) } catch (_: Exception) {}
        }
        callIdReadyReceiver = null
      }
    }
    val filterReady = IntentFilter(OutgoingCallActivity.ACTION_OUTGOING_CALL_ID_READY)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.registerReceiver(callIdReadyReceiver, filterReady, Context.RECEIVER_NOT_EXPORTED)
    } else {
      activity.registerReceiver(callIdReadyReceiver, filterReady)
    }
  }

  private fun scheduleEmptyCallIdTimeout() {
    callIdEmptyTimeoutRunnable?.let { handler.removeCallbacks(it) }
    callIdEmptyTimeoutRunnable = Runnable {
      callIdEmptyTimeoutRunnable = null
      if (isVisible && callId.startsWith("pending_")) {
        Log.d(TAG, "No real callId within timeout — hide overlay")
        hideInternal(host, stopRingback = true)
      }
    }
    handler.postDelayed(callIdEmptyTimeoutRunnable!!, 27_000L)
  }

  private fun restartProvisionalRingback(activity: MainActivity) {
    cancelDeferredRingbackStop()
    callIdEmptyTimeoutRunnable?.let { handler.removeCallbacks(it) }
    callIdEmptyTimeoutRunnable = null

    val provisionalId = "pending_${System.currentTimeMillis()}"
    pendingProvisionalId = provisionalId
    callId = provisionalId
    LiviOngoingCallHelper.setOutgoingCall(activity, provisionalId, toUserId, toNick)
    LiviOutgoingCallService.start(activity, provisionalId, toUserId, toNick)
    attachCallIdReceiver(activity)
    scheduleEmptyCallIdTimeout()
  }

  private fun shouldAcceptCloseBroadcast(broadcastCallId: String, forceClose: Boolean): Boolean {
    val incoming = broadcastCallId.trim()
    val current = callId.trim()
    // Как OutgoingCallActivity: не принимать чужой/пустой CLOSE во время активного dial.
    if (forceClose && incoming.isEmpty()) {
      return current.isEmpty()
    }
    if (incoming.isEmpty()) {
      return current.isEmpty()
    }
    if (incoming == current) return true
    // pending ещё не bind: CLOSE с реальным id этого же dial (FGS уже adopt) — закрыть.
    // CLOSE со старым callId прошлого cancel — isRingingActive(old)=false → reject.
    if (
      current.startsWith("pending_") &&
      !incoming.startsWith("pending_") &&
      LiviOutgoingCallService.isRingingActive(incoming)
    ) {
      return true
    }
    return false
  }

  private fun registerReceivers(activity: MainActivity) {
    closeReceiver?.let {
      try { activity.unregisterReceiver(it) } catch (_: Exception) {}
    }
    closeReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val broadcastCallId = intent?.getStringExtra(OutgoingCallActivity.EXTRA_CALL_ID) ?: ""
        val forceClose = intent?.getBooleanExtra(OutgoingCallActivity.EXTRA_FORCE_CLOSE, false) == true
        if (!shouldAcceptCloseBroadcast(broadcastCallId, forceClose)) {
          Log.d(TAG, "CLOSE ignored broadcast=${broadcastCallId.take(24)} current=${callId.take(24)}")
          return
        }
        if (hideRequested) return
        hideRequested = true
        hideInternal(host, stopRingback = true)
      }
    }
    val filter = IntentFilter(OutgoingCallActivity.ACTION_CLOSE_OUTGOING_CALL)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      activity.registerReceiver(closeReceiver, filter)
    }
  }

  private fun hideInternal(activity: MainActivity?, stopRingback: Boolean) {
    val id = callId
    isVisible = false
    dotsRunnable?.let { handler.removeCallbacks(it) }
    dotsRunnable = null
    callIdEmptyTimeoutRunnable?.let { handler.removeCallbacks(it) }
    callIdEmptyTimeoutRunnable = null

    val act = activity ?: host
    if (act != null) {
      closeReceiver?.let {
        try { act.unregisterReceiver(it) } catch (_: Exception) {}
      }
      callIdReadyReceiver?.let {
        try { act.unregisterReceiver(it) } catch (_: Exception) {}
      }
    }
    closeReceiver = null
    callIdReadyReceiver = null

    val view = root
    root = null
    host = null
    if (view != null) {
      try {
        (view.parent as? ViewGroup)?.removeView(view)
      } catch (_: Exception) {}
    }

    if (stopRingback && id.isNotEmpty()) {
      val ctx = act?.applicationContext
      if (ctx != null) {
        try {
          LiviOutgoingCallService.silencePlayerOnly()
        } catch (_: Exception) {}
        scheduleDeferredRingbackStop(ctx, id)
      }
    }
    callId = ""
    Log.d(TAG, "hideInternal stopRingback=$stopRingback")
  }

  private fun startDotsAnimation(subtitleView: TextView, video: Boolean) {
    dotsRunnable?.let { handler.removeCallbacks(it) }
    val base = subtitleView.context.getString(
      if (video) R.string.outgoing_call_subtitle_base else R.string.outgoing_call_subtitle_base_audio,
    )
    dotsCount = 1
    subtitleView.text = "$base."
    dotsRunnable = object : Runnable {
      override fun run() {
        dotsCount = (dotsCount % 3) + 1
        subtitleView.text = base + ".".repeat(dotsCount)
        handler.postDelayed(this, 400L)
      }
    }
    handler.postDelayed(dotsRunnable!!, 400L)
  }

  private fun installPressFeedback(button: ImageButton) {
    button.setOnTouchListener { view, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          view.animate().scaleX(0.92f).scaleY(0.92f).setDuration(60).start()
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          view.animate().scaleX(1f).scaleY(1f).setDuration(80).start()
        }
      }
      false
    }
  }
}
