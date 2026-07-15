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

    override fun onCreate(savedInstanceState: Bundle?) {
        ScreenOrientationHelper.applyPhonePortraitTabletAny(this)
        super.onCreate(savedInstanceState)
        val closeImmediately = intent.getBooleanExtra(EXTRA_CLOSE_IMMEDIATELY, false)
        Log.d(TAG, "onCreate: closeImmediately=$closeImmediately callId=${intent.getStringExtra(EXTRA_CALL_ID) ?: ""} toUserId=${intent.getStringExtra(EXTRA_TO_USER_ID) ?: ""}")
        // FCM call_declined может запустить активность с флагом «сразу закрыть» (приложение было в фоне/убито — broadcast не дошёл)
        if (closeImmediately) {
            Log.d(TAG, "onCreate: finishing immediately (EXTRA_CLOSE_IMMEDIATELY)")
            LiviOutgoingCallService.stop(this)
            finish()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        setContentView(R.layout.activity_outgoing_call)

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
            callIdReadyReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val id = intent?.getStringExtra(EXTRA_CALL_ID) ?: return
                    Log.d(TAG, "onReceive ACTION_OUTGOING_CALL_ID_READY: callId=${id.take(24)}")
                    if (id.isNotEmpty()) {
                        callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
                        callIdEmptyTimeoutRunnable = null
                        this@OutgoingCallActivity.callId = id
                        LiviOngoingCallHelper.setOutgoingCall(this@OutgoingCallActivity, id, toUserId, toNick)
                        LiviOutgoingCallService.start(this@OutgoingCallActivity, id, toUserId, toNick)
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
                if (this@OutgoingCallActivity.callId.isEmpty()) {
                    Log.d(TAG, "No callId received within timeout, finishing (cold start without real call)")
                    LiviOutgoingCallService.stop(this@OutgoingCallActivity)
                    finish()
                }
            }
            timeoutHandler.postDelayed(callIdEmptyTimeoutRunnable!!, 27000L)
        }

        val cancelButton = findViewById<ImageButton>(R.id.btn_cancel)
        installPressFeedback(cancelButton)

        cancelButton.setOnClickListener {
            var effectiveCallId = callId
            if (effectiveCallId.isEmpty()) {
                effectiveCallId = LiviOngoingCallHelper.peekOutgoingCall(this)?.first ?: ""
                if (effectiveCallId.isNotEmpty()) {
                    this@OutgoingCallActivity.callId = effectiveCallId
                }
            }
            LiviAppModule.emitOutgoingCallCanceledByUser(effectiveCallId)
            if (effectiveCallId.isNotEmpty()) {
                LiviOutgoingCallService.cancelCallOnServer(this, effectiveCallId)
            }
            LiviOutgoingCallService.stop(this)
            mainReturnScheduledForUserCancel = true
            returnMainActivityImmediately()
            LiviAppModule.scheduleMainActivityAfterOutgoingUserCancel(applicationContext)
            finish()
        }

        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val broadcastCallId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
                val forceClose = intent?.getBooleanExtra(EXTRA_FORCE_CLOSE, false) == true
                val forceUnscopedClose = forceClose && broadcastCallId.isEmpty()
                val matchesCurrentCall = broadcastCallId.isNotEmpty() && broadcastCallId == this@OutgoingCallActivity.callId
                val closesPendingNoCallId = broadcastCallId.isEmpty() && this@OutgoingCallActivity.callId.isEmpty()
                if (forceUnscopedClose || matchesCurrentCall || closesPendingNoCallId) {
                    LiviOutgoingCallService.stop(this@OutgoingCallActivity)
                    finish()
                } else {
                    Log.d(TAG, "ACTION_CLOSE_OUTGOING_CALL ignored broadcastCallId=${broadcastCallId.take(24)} currentCallId=${this@OutgoingCallActivity.callId.take(24)} force=$forceClose")
                }
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
            Log.d(TAG, "onNewIntent: EXTRA_CLOSE_IMMEDIATELY -> finishing")
            LiviOutgoingCallService.stop(this)
            finish()
            return
        }
        // Повторное нажатие «Видеозвонок» после отмены/таймаута: обновляем экран под новый вызов
        val newToUserId = intent.getStringExtra(EXTRA_TO_USER_ID) ?: ""
        val newToNick = intent.getStringExtra(EXTRA_TO_NICK) ?: ""
        callId = newCallId
        toUserId = newToUserId
        toNick = newToNick
        LiviOngoingCallHelper.setOutgoingCall(this, newCallId, newToUserId, newToNick)
        LiviOutgoingCallService.stop(this)
        findViewById<TextView>(R.id.callee_name).text = if (newToNick.isNotEmpty()) newToNick else getString(R.string.outgoing_call_title)
        if (newCallId.isNotEmpty()) {
            callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
            callIdEmptyTimeoutRunnable = null
            callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
            callIdReadyReceiver = null
            LiviOutgoingCallService.start(this, newCallId, newToUserId, newToNick)
        } else {
            callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
            callIdReadyReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, rcvIntent: Intent?) {
                    val id = rcvIntent?.getStringExtra(EXTRA_CALL_ID) ?: return
                    if (id.isNotEmpty()) {
                        callIdEmptyTimeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
                        callIdEmptyTimeoutRunnable = null
                        this@OutgoingCallActivity.callId = id
                        LiviOngoingCallHelper.setOutgoingCall(this@OutgoingCallActivity, id, toUserId, toNick)
                        LiviOutgoingCallService.start(this@OutgoingCallActivity, id, toUserId, toNick)
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
                if (this@OutgoingCallActivity.callId.isEmpty()) {
                    Log.d(TAG, "No callId received within timeout (onNewIntent), finishing")
                    LiviOutgoingCallService.stop(this@OutgoingCallActivity)
                    finish()
                }
            }
            timeoutHandler.postDelayed(callIdEmptyTimeoutRunnable!!, 27000L)
        }
    }

    override fun finish() {
        super.finish()
        // Убираем системную анимацию закрытия, чтобы не было "мерцания/уезда" Home
        // при возврате с нативного экрана исходящего вызова.
        overridePendingTransition(0, 0)
        if (!mainReturnScheduledForUserCancel) {
            LiviAppModule.scheduleMainActivityAfterOutgoingClose(applicationContext)
        }
    }

    /**
     * Домой / Недавние: то же поведение, что и «Назад» — экран уходит в фон, вызов продолжается,
     * вернуться по уведомлению в шторке (без завершения экрана и без отмены вызова).
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (suppressMoveToBackOnUserLeaveHint) {
            Log.d(TAG, "onUserLeaveHint: skip moveTaskToBack for internal MainActivity return")
            return
        }
        moveTaskToBack(true)
    }

    private fun returnMainActivityImmediately() {
        suppressMoveToBackOnUserLeaveHint = true
        try {
            val mainIntent = Intent(this, MainActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
                        or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
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
        LiviOngoingCallHelper.clearOngoingCall(applicationContext)
        LiviOutgoingCallService.stop(this)
        dotsRunnable?.let { timeoutHandler.removeCallbacks(it) }
        dotsRunnable = null
        closeReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        closeReceiver = null
        callIdReadyReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callIdReadyReceiver = null
        super.onDestroy()
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
    }
}
