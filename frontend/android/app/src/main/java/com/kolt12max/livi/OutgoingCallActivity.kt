package com.kolt12max.livi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var dotsRunnable: Runnable? = null
    private var callId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        setContentView(R.layout.activity_outgoing_call)

        callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        val toUserId = intent.getStringExtra(EXTRA_TO_USER_ID) ?: ""
        val toNick = intent.getStringExtra(EXTRA_TO_NICK) ?: ""

        findViewById<TextView>(R.id.callee_name).text = if (toNick.isNotEmpty()) toNick else getString(R.string.outgoing_call_title)
        val subtitleView = findViewById<TextView>(R.id.call_subtitle)
        startDotsAnimation(subtitleView)

        LiviOutgoingCallService.start(this, callId, toUserId, toNick)

        findViewById<ImageButton>(R.id.btn_cancel).setOnClickListener {
            LiviOutgoingCallService.cancelCallOnServer(this, callId)
            LiviOutgoingCallService.stop(this)
            finish()
        }

        closeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                LiviOutgoingCallService.stop(this@OutgoingCallActivity)
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
        super.onDestroy()
    }

    companion object {
        private const val TAG = "OutgoingCallActivity"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_TO_USER_ID = "toUserId"
        const val EXTRA_TO_NICK = "toNick"
        const val ACTION_CLOSE_OUTGOING_CALL = "com.kolt12max.livi.CLOSE_OUTGOING_CALL"
    }
}
