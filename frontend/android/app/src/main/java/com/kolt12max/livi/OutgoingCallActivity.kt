package com.kolt12max.livi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
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

    private var closeReceiver: BroadcastReceiver? = null
    private var callIdReadyReceiver: BroadcastReceiver? = null
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var dotsRunnable: Runnable? = null
    private var callId: String = ""
    private var toUserId: String = ""
    private var toNick: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // FCM call_declined может запустить активность с флагом «сразу закрыть» (приложение было в фоне/убито — broadcast не дошёл)
        if (intent.getBooleanExtra(EXTRA_CLOSE_IMMEDIATELY, false)) {
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

        findViewById<TextView>(R.id.callee_name).text = if (toNick.isNotEmpty()) toNick else getString(R.string.outgoing_call_title)
        val subtitleView = findViewById<TextView>(R.id.call_subtitle)
        startDotsAnimation(subtitleView)

        if (callId.isNotEmpty()) {
            LiviOutgoingCallService.start(this, callId, toUserId, toNick)
        } else {
            callIdReadyReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val id = intent?.getStringExtra(EXTRA_CALL_ID) ?: return
                    if (id.isNotEmpty()) {
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
        }

        findViewById<ImageButton>(R.id.btn_cancel).setOnClickListener {
            LiviAppModule.emitOutgoingCallCanceledByUser()
            if (callId.isNotEmpty()) {
                LiviOutgoingCallService.cancelCallOnServer(this, callId)
            }
            LiviOutgoingCallService.stop(this)
            finish()
        }

        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val broadcastCallId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
                if (broadcastCallId.isEmpty() || broadcastCallId == this@OutgoingCallActivity.callId) {
                    LiviOutgoingCallService.stop(this@OutgoingCallActivity)
                    finish()
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
        if (intent.getBooleanExtra(EXTRA_CLOSE_IMMEDIATELY, false)) {
            Log.d(TAG, "onNewIntent: EXTRA_CLOSE_IMMEDIATELY -> finishing")
            LiviOutgoingCallService.stop(this)
            finish()
        }
    }

    /**
     * Домой / Недавние: то же поведение, что и «Назад» — экран уходит в фон, вызов продолжается,
     * вернуться по уведомлению в шторке (без завершения экрана и без отмены вызова).
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        moveTaskToBack(true)
    }

    private var dotsCount = 0
    private fun startDotsAnimation(subtitleView: TextView) {
        val base = getString(R.string.outgoing_call_subtitle_base)
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

    companion object {
        private const val TAG = "OutgoingCallActivity"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_TO_USER_ID = "toUserId"
        const val EXTRA_TO_NICK = "toNick"
        /** FCM call_declined запускает активность с этим флагом, чтобы закрыть экран, если broadcast не дошёл (приложение в фоне/убито). */
        const val EXTRA_CLOSE_IMMEDIATELY = "close_immediately"
        const val ACTION_CLOSE_OUTGOING_CALL = "com.kolt12max.livi.CLOSE_OUTGOING_CALL"
        /** Broadcast: JS получил callId с сервера — запустить сервис (звук, таймаут). */
        const val ACTION_OUTGOING_CALL_ID_READY = "com.kolt12max.livi.OUTGOING_CALL_ID_READY"
    }
}
