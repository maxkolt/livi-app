package com.kolt12max.livi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.graphics.PixelFormat
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Нативный полноэкранный экран исходящего видеозвонка (вместо in-app модалки).
 * Звук и таймаут 20с — в LiviOutgoingCallService (играет WAV в фоне при Back/свернутом приложении).
 * Кнопка «Назад» → уход в фон без завершения вызова. По уведомлению — возврат на экран.
 */
class OutgoingCallActivity : AppCompatActivity() {

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(FontScaleContextHelper.wrap(newBase))
    }

    override fun applyOverrideConfiguration(overrideConfiguration: Configuration?) {
        if (overrideConfiguration != null) {
            super.applyOverrideConfiguration(FontScaleContextHelper.copyPatched(overrideConfiguration))
        } else {
            super.applyOverrideConfiguration(null)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(FontScaleContextHelper.copyPatched(newConfig))
    }

    private var closeReceiver: BroadcastReceiver? = null
    private var callIdReadyReceiver: BroadcastReceiver? = null
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var dotsRunnable: Runnable? = null
    private var callIdEmptyTimeoutRunnable: Runnable? = null
    private var callId: String = ""
    private var toUserId: String = ""
    private var toNick: String = ""
    /** Отмена с кнопки X: Main уже запланирован без debounce — не дублировать в finish(). */
    private var mainReturnScheduledForUserCancel = false
    /** Внутренний переход обратно в MainActivity не должен трактоваться как Home/Recents. */
    private var suppressMoveToBackOnUserLeaveHint = false
    /** Broadcast/JS могут дернуть close много раз — один finish() на lifetime Activity. */
    private var finishRequested = false

    override fun onCreate(savedInstanceState: Bundle?) {
        ScreenOrientationHelper.applyPhonePortraitTabletAny(this)
        super.onCreate(savedInstanceState)
        isAlive = true
        EdgeToEdgeHelper.apply(this)
        val closeImmediately = intent.getBooleanExtra(EXTRA_CLOSE_IMMEDIATELY, false)
        Log.d(TAG, "onCreate: closeImmediately=$closeImmediately callId=${intent.getStringExtra(EXTRA_CALL_ID) ?: ""} toUserId=${intent.getStringExtra(EXTRA_TO_USER_ID) ?: ""}")
        // FCM call_declined может запустить активность с флагом «сразу закрыть» (приложение было в фоне/убито — broadcast не дошёл)
        if (closeImmediately) {
            Log.d(TAG, "onCreate: finishing immediately (EXTRA_CLOSE_IMMEDIATELY)")
            val closeId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
            LiviOutgoingCallService.stop(this, closeId)
            finish()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        window.setFormat(PixelFormat.RGBA_8888)
        setContentView(R.layout.activity_outgoing_call)
        findViewById<View>(R.id.outgoing_call_content)?.let { EdgeToEdgeHelper.applySystemBarInsets(it) }

        callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        toUserId = intent.getStringExtra(EXTRA_TO_USER_ID) ?: ""
        toNick = intent.getStringExtra(EXTRA_TO_NICK) ?: ""
        Log.d(TAG, "onCreate: activity created callId=$callId toUserId=$toUserId toNick=${toNick.take(20)}")

        findViewById<TextView>(R.id.callee_name).text = if (toNick.isNotEmpty()) toNick else getString(R.string.outgoing_call_title)
        val subtitleView = findViewById<TextView>(R.id.call_subtitle)
        val hasVideo = intent.getBooleanExtra(EXTRA_HAS_VIDEO, true)
        startDotsAnimation(subtitleView, hasVideo)

        if (callId.isNotEmpty()) {
            LiviOutgoingCallService.start(this, callId, toUserId, toNick)
        } else {
            // Сразу ringback, не ждать call:initiate — иначе cancel→redial «думает» до notifyOutgoingCallId.
            val provisionalId = "pending_${System.currentTimeMillis()}"
            callId = provisionalId
            LiviOngoingCallHelper.setOutgoingCall(this, provisionalId, toUserId, toNick)
            LiviOutgoingCallService.start(this, provisionalId, toUserId, toNick)
            callIdReadyReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val id = intent?.getStringExtra(EXTRA_CALL_ID) ?: return
                    Log.d(TAG, "onReceive ACTION_OUTGOING_CALL_ID_READY: callId=${id.take(24)}")
                    if (id.isNotEmpty()) {
                        callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
                        callIdEmptyTimeoutRunnable = null
                        val prev = this@OutgoingCallActivity.callId
                        this@OutgoingCallActivity.callId = id
                        LiviOngoingCallHelper.setOutgoingCall(this@OutgoingCallActivity, id, toUserId, toNick)
                        if (!LiviOutgoingCallService.adoptRealCallId(this@OutgoingCallActivity, id, toUserId, toNick)) {
                            // Provisional не играл — обычный старт.
                            if (prev.startsWith("pending_")) {
                                LiviOutgoingCallService.stop(this@OutgoingCallActivity, prev)
                            }
                            LiviOutgoingCallService.start(this@OutgoingCallActivity, id, toUserId, toNick)
                        }
                        callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
                        callIdReadyReceiver = null
                    }
                }
            }
            val filterReady = IntentFilter(ACTION_OUTGOING_CALL_ID_READY)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(callIdReadyReceiver, filterReady, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(callIdReadyReceiver, filterReady)
            }
            // Холодный старт: если callId так и не пришёл (нет реального исходящего вызова) — закрыть экран. 27 сек — как серверный таймаут входящего.
            callIdEmptyTimeoutRunnable = Runnable {
                callIdEmptyTimeoutRunnable = null
                if (this@OutgoingCallActivity.callId.startsWith("pending_")) {
                    Log.d(TAG, "No real callId received within timeout, finishing (cold start without real call)")
                    LiviOutgoingCallService.stop(this@OutgoingCallActivity, this@OutgoingCallActivity.callId)
                    finish()
                }
            }
            timeoutHandler.postDelayed(callIdEmptyTimeoutRunnable!!, 27000L)
        }

        val cancelButton = findViewById<ImageButton>(R.id.btn_cancel)
        installPressFeedback(cancelButton)

        cancelButton.setOnClickListener {
            // Только локальный callId Activity. peekOutgoingCall опасен при redial:
            // prefs уже новый звонок → HTTP cancel убьёт его на сервере.
            val effectiveCallId = callId
            LiviAppModule.emitOutgoingCallCanceledByUser(
                if (effectiveCallId.startsWith("pending_")) "" else effectiveCallId,
            )
            if (effectiveCallId.isNotEmpty() && !effectiveCallId.startsWith("pending_")) {
                LiviOutgoingCallService.cancelCallOnServer(this, effectiveCallId)
            }
            // Сначала finish (вернуть Main), потом ringback stop — иначе MediaPlayer на main
            // держит UI до resume и RN таймеры/тачи «спят» секунды.
            mainReturnScheduledForUserCancel = true
            // Same-task Outgoing (!isTaskRoot): достаточно finish() — Main уже под ним.
            // returnMain+CLEAR_TOP раньше пересоздавал Main → RN freeze 5–7с.
            if (isTaskRoot && !MainActivity.isInForeground) {
                returnMainActivityImmediately()
            }
            finish()
            // Mute/stop строго вне UI-кадра finish/resume Main.
            Thread({
                try {
                    LiviOutgoingCallService.silenceAndStop(applicationContext, effectiveCallId)
                } catch (_: Exception) {}
            }, "livi-outgoing-silence").start()
        }

        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val broadcastCallId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
                val forceClose = intent?.getBooleanExtra(EXTRA_FORCE_CLOSE, false) == true
                if (!shouldAcceptCloseBroadcast(broadcastCallId, forceClose)) {
                    Log.d(
                        TAG,
                        "ACTION_CLOSE_OUTGOING_CALL ignored broadcastCallId=${broadcastCallId.take(24)} currentCallId=${callId.take(24)} force=$forceClose",
                    )
                    return
                }
                if (finishRequested || isFinishing || isDestroyed) {
                    return
                }
                LiviOutgoingCallService.stop(this@OutgoingCallActivity, this@OutgoingCallActivity.callId)
                finish()
            }
        }
        val filter = IntentFilter(ACTION_CLOSE_OUTGOING_CALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(closeReceiver, filter)
        }

        // Назад: экран уходит в фон, вызов продолжается, вернуться по уведомлению в шторке.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val closeImmediately = intent.getBooleanExtra(EXTRA_CLOSE_IMMEDIATELY, false)
        val newCallId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        Log.d(TAG, "onNewIntent: closeImmediately=$closeImmediately newCallId=${newCallId.take(24)}")
        if (closeImmediately) {
            if (!shouldAcceptIncomingCloseId(newCallId)) {
                return
            }
            Log.d(TAG, "onNewIntent: EXTRA_CLOSE_IMMEDIATELY -> finishing")
            LiviOutgoingCallService.stop(this, callId.ifBlank { newCallId })
            finish()
            return
        }
        // Повторное нажатие «Видеозвонок» после отмены/таймаута: обновляем экран под новый вызов
        val newToUserId = intent.getStringExtra(EXTRA_TO_USER_ID) ?: ""
        val newToNick = intent.getStringExtra(EXTRA_TO_NICK) ?: ""
        val newHasVideo = intent.getBooleanExtra(EXTRA_HAS_VIDEO, true)
        val previousCallId = callId
        callId = newCallId
        toUserId = newToUserId
        toNick = newToNick
        LiviOngoingCallHelper.setOutgoingCall(this, newCallId, newToUserId, newToNick)
        // Гасим только предыдущий ringback, не unscoped (иначе убьём только что стартовавший).
        LiviOutgoingCallService.stop(this, previousCallId)
        findViewById<TextView>(R.id.callee_name).text = if (newToNick.isNotEmpty()) newToNick else getString(R.string.outgoing_call_title)
        findViewById<TextView>(R.id.call_subtitle)?.let { startDotsAnimation(it, newHasVideo) }
        if (newCallId.isNotEmpty()) {
            callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
            callIdEmptyTimeoutRunnable = null
            callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
            callIdReadyReceiver = null
            LiviOutgoingCallService.start(this, newCallId, newToUserId, newToNick)
        } else {
            // Replace/redial: сразу provisional ringback, как в onCreate.
            callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
            callIdEmptyTimeoutRunnable = null
            callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
            callIdReadyReceiver = null
            val provisionalId = "pending_${System.currentTimeMillis()}"
            callId = provisionalId
            LiviOngoingCallHelper.setOutgoingCall(this, provisionalId, newToUserId, newToNick)
            LiviOutgoingCallService.start(this, provisionalId, newToUserId, newToNick)
            callIdReadyReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, rcvIntent: Intent?) {
                    val id = rcvIntent?.getStringExtra(EXTRA_CALL_ID) ?: return
                    if (id.isNotEmpty()) {
                        callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
                        callIdEmptyTimeoutRunnable = null
                        val prev = this@OutgoingCallActivity.callId
                        this@OutgoingCallActivity.callId = id
                        LiviOngoingCallHelper.setOutgoingCall(this@OutgoingCallActivity, id, toUserId, toNick)
                        if (!LiviOutgoingCallService.adoptRealCallId(this@OutgoingCallActivity, id, toUserId, toNick)) {
                            if (prev.startsWith("pending_")) {
                                LiviOutgoingCallService.stop(this@OutgoingCallActivity, prev)
                            }
                            LiviOutgoingCallService.start(this@OutgoingCallActivity, id, toUserId, toNick)
                        }
                        callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
                        callIdReadyReceiver = null
                    }
                }
            }
            val filterReady = IntentFilter(ACTION_OUTGOING_CALL_ID_READY)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(callIdReadyReceiver, filterReady, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(callIdReadyReceiver, filterReady)
            }
            callIdEmptyTimeoutRunnable = Runnable {
                callIdEmptyTimeoutRunnable = null
                if (this@OutgoingCallActivity.callId.startsWith("pending_")) {
                    Log.d(TAG, "No real callId received within timeout (onNewIntent), finishing")
                    LiviOutgoingCallService.stop(this@OutgoingCallActivity, this@OutgoingCallActivity.callId)
                    finish()
                }
            }
            timeoutHandler.postDelayed(callIdEmptyTimeoutRunnable!!, 27000L)
        }
    }

    override fun finish() {
        if (finishRequested || isFinishing || isDestroyed) {
            Log.d(TAG, "finish: skip duplicate (requested=$finishRequested isFinishing=$isFinishing)")
            return
        }
        finishRequested = true
        // Раньше onDestroy: cancel→redial не ждёт 120ms close+delay пока isAlive ещё true.
        isAlive = false
        // До super.finish(): после finish isTaskRoot уже бессмысленен.
        val needsMainReorder = !mainReturnScheduledForUserCancel && isTaskRoot
        super.finish()
        // Убираем системную анимацию закрытия, чтобы не было "мерцания/уезда" Home
        // при возврате с нативного экрана исходящего вызова.
        overridePendingTransition(0, 0)
        // Same-task: Main под Outgoing — scheduleMain не нужен (и даёт AppState churn).
        // Отдельный task (was task root) без user-cancel return — поднять Main, иначе лаунчер.
        if (needsMainReorder) {
            LiviAppModule.scheduleMainActivityAfterOutgoingClose(applicationContext)
        }
    }

    /**
     * Домой / Недавние: то же поведение, что и «Назад» — экран уходит в фон, вызов продолжается,
     * вернуться по уведомлению в шторке (без завершения экрана и без отмены вызова).
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (suppressMoveToBackOnUserLeaveHint || finishRequested || isFinishing || mainReturnScheduledForUserCancel) {
            Log.d(TAG, "onUserLeaveHint: skip moveTaskToBack (finishing/cancel/internal)")
            return
        }
        moveTaskToBack(true)
    }

    private fun returnMainActivityImmediately() {
        suppressMoveToBackOnUserLeaveHint = true
        try {
            // Без CLEAR_TOP: иначе Main пересоздаётся → RN remount 5–7с (табы/redial «мёртвые»).
            // REORDER_TO_FRONT + SINGLE_TOP достаточно вернуть уже живой Main.
            val mainIntent = Intent(this, MainActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        or Intent.FLAG_ACTIVITY_NO_ANIMATION
                )
            }
            startActivity(mainIntent)
            overridePendingTransition(0, 0)
            Log.d(TAG, "returnMainActivityImmediately: MainActivity started before finish")
        } catch (e: Exception) {
            Log.w(TAG, "returnMainActivityImmediately failed", e)
        }
    }

    private var dotsCount = 0
    private fun startDotsAnimation(subtitleView: TextView, hasVideo: Boolean = true) {
        val base = getString(if (hasVideo) R.string.outgoing_call_subtitle_base else R.string.outgoing_call_subtitle_base_audio)
        dotsRunnable = object : Runnable {
            override fun run() {
                dotsCount = (dotsCount % 3) + 1
                subtitleView.text = base + ".".repeat(dotsCount)
                timeoutHandler.postDelayed(this, 400L)
            }
        }
        subtitleView.text = base + "."
        dotsCount = 1
        timeoutHandler.postDelayed(dotsRunnable!!, 400L)
    }

    override fun onDestroy() {
        callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
        callIdEmptyTimeoutRunnable = null
        // Не wipe всех prefs: при cancel→redial старый Activity.onDestroy иначе
        // сносит prefs уже нового исходящего → callee accept → not_found.
        if (callId.isNotBlank()) {
            LiviOngoingCallHelper.clearOngoingCallIfMatches(applicationContext, callId)
            LiviOutgoingCallService.stop(this, callId)
        } else {
            LiviOngoingCallHelper.clearPendingEmptyOutgoingPrefs(applicationContext)
        }
        dotsRunnable?.let { timeoutHandler.removeCallbacks(it) }
        dotsRunnable = null
        closeReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        closeReceiver = null
        callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callIdReadyReceiver = null
        isAlive = false
        super.onDestroy()
    }

    /**
     * FCM / bringMain шлют CLOSE с опозданием — не закрывать новый исходящий
     * (redial уже с другим callId или callId ещё пустой на этом экране).
     */
    private fun shouldAcceptIncomingCloseId(incomingCallId: String): Boolean {
        val current = callId.trim()
        val incoming = incomingCallId.trim()
        if (current.isNotEmpty()) {
            if (incoming.isEmpty()) {
                Log.d(
                    TAG,
                    "shouldAcceptIncomingCloseId: reject unscoped close while active callId=${current.take(24)}",
                )
                return false
            }
            if (incoming != current) {
                Log.d(
                    TAG,
                    "shouldAcceptIncomingCloseId: reject stale close incoming=${incoming.take(24)} current=${current.take(24)}",
                )
                return false
            }
            return true
        }
        if (incoming.isNotEmpty()) {
            Log.d(
                TAG,
                "shouldAcceptIncomingCloseId: reject scoped close while pending callId incoming=${incoming.take(24)}",
            )
            return false
        }
        return true
    }

    private fun shouldAcceptCloseBroadcast(broadcastCallId: String, forceClose: Boolean): Boolean {
        val incoming = broadcastCallId.trim()
        if (forceClose && incoming.isEmpty()) {
            return shouldAcceptIncomingCloseId("")
        }
        if (incoming.isEmpty()) {
            return callId.trim().isEmpty()
        }
        return shouldAcceptIncomingCloseId(incoming) && incoming == callId.trim()
    }

    private fun installPressFeedback(button: ImageButton) {
        button.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> animateButtonPress(view, pressed = true)
                MotionEvent.ACTION_UP,
                MotionEvent.ACTION_CANCEL -> animateButtonPress(view, pressed = false)
            }
            false
        }
    }

    private fun animateButtonPress(view: View, pressed: Boolean) {
        val scale = if (pressed) 0.86f else 1f
        val alpha = if (pressed) 0.78f else 1f
        view.animate()
            .scaleX(scale)
            .scaleY(scale)
            .alpha(alpha)
            .setDuration(if (pressed) 90L else 140L)
            .start()
    }

    companion object {
        private const val TAG = "OutgoingCallActivity"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_TO_USER_ID = "toUserId"
        const val EXTRA_TO_NICK = "toNick"
        const val EXTRA_HAS_VIDEO = "hasVideo"
        /** FCM call_declined запускает активность с этим флагом, чтобы закрыть экран, если broadcast не дошёл (приложение в фоне/убито). */
        const val EXTRA_CLOSE_IMMEDIATELY = "close_immediately"
        const val EXTRA_FORCE_CLOSE = "force_close"
        const val ACTION_CLOSE_OUTGOING_CALL = "com.kolt12max.livi.CLOSE_OUTGOING_CALL"
        /** Broadcast: JS получил callId с сервера — запустить сервис (звук, таймаут). */
        const val ACTION_OUTGOING_CALL_ID_READY = "com.kolt12max.livi.OUTGOING_CALL_ID_READY"
        /** true пока экземпляр OutgoingCallActivity существует (cancel→redial: без лишней паузы close+delay). */
        @JvmField
        var isAlive: Boolean = false
    }
}
