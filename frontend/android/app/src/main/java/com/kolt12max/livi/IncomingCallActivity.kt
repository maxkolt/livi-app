package com.kolt12max.livi

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Полноэкранный экран входящего звонка (full-screen intent, как WhatsApp/Telegram).
 * Показывается поверх блокировки и других приложений при FCM-пуше о звонке.
 * Принять → открывает MainActivity с livi://answer-call → приложение подключается к звонку.
 * Отклонить → открывает MainActivity с livi://decline-call → приложение отправляет decline на сервер.
 */
class IncomingCallActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        setContentView(R.layout.activity_incoming_call)

        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)

        val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        val from = intent.getStringExtra(EXTRA_FROM) ?: ""
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""

        findViewById<TextView>(R.id.caller_name).text = if (fromNick.isNotEmpty()) fromNick else getString(R.string.incoming_call_title)
        findViewById<TextView>(R.id.call_subtitle).text = getString(R.string.incoming_call_title)

        findViewById<ImageButton>(R.id.btn_accept).setOnClickListener {
            val answerUri = "livi://answer-call?callId=${Uri.encode(callId)}&from=${Uri.encode(from)}&fromNick=${URLEncoder.encode(fromNick, StandardCharsets.UTF_8.toString())}"
            startMainWithDeepLink(answerUri)
            finish()
        }

        findViewById<ImageButton>(R.id.btn_decline).setOnClickListener {
            val declineUri = "livi://decline-call?callId=${Uri.encode(callId)}"
            startMainWithDeepLink(declineUri)
            finish()
        }
    }

    private fun startMainWithDeepLink(deepLink: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
            setClassName(applicationContext, "com.kolt12max.livi.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        startActivity(intent)
    }

    companion object {
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
    }
}
