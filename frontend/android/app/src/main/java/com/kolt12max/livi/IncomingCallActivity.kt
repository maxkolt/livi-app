package com.kolt12max.livi

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Полноэкранный экран входящего звонка (full-screen intent, как WhatsApp/Telegram).
 * Показывается поверх блокировки и других приложений при FCM-пуше о звонке.
 * Принять → открывает MainActivity с livi://answer-call → приложение подключается к звонку.
 * Отклонить → по HTTP на сервер (без открытия приложения), иначе livi://decline-call.
 * При отмене инициатором приходит FCM call_canceled → broadcast → finish() без мельканий.
 */
class IncomingCallActivity : AppCompatActivity() {

    private var currentCallId: String = ""
    private var callCanceledReceiver: BroadcastReceiver? = null
    private var callAnsweredReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Убираем уведомление полностью — при входящем звонке только нативный экран, без шторки и баннера
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        setContentView(R.layout.activity_incoming_call)

        startRepeatingVibration()
        currentCallId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        val callId = currentCallId
        val from = intent.getStringExtra(EXTRA_FROM) ?: ""
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        LiviOngoingCallHelper.setIncomingCall(this, callId, from, fromNick)

        findViewById<TextView>(R.id.caller_name).text = if (fromNick.isNotEmpty()) fromNick else getString(R.string.incoming_call_unknown)
        findViewById<TextView>(R.id.call_subtitle).text = getString(R.string.incoming_call_title)

        findViewById<ImageButton>(R.id.btn_accept).setOnClickListener {
            stopRepeatingVibration()
            val answerUri = "livi://answer-call?callId=${Uri.encode(callId)}&from=${Uri.encode(from)}&fromNick=${URLEncoder.encode(fromNick, StandardCharsets.UTF_8.toString())}"
            startMainWithDeepLink(answerUri)
            finish()
        }

        findViewById<ImageButton>(R.id.btn_decline).setOnClickListener {
            stopRepeatingVibration()
            declineCallFromNative(callId)
        }

        callCanceledReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val canceledCallId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (canceledCallId == currentCallId) {
                    stopRepeatingVibration()
                    finish()
                }
            }
        }
        val filter = IntentFilter(LiviFirebaseMessagingService.ACTION_CALL_CANCELED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callCanceledReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(callCanceledReceiver, filter)
        }

        // При ответе из уведомления (livi://answer-call) JS шлёт broadcast — закрываем экран.
        callAnsweredReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val answeredCallId = intent?.getStringExtra(EXTRA_CALL_ID) ?: return
                if (answeredCallId == currentCallId) {
                    stopRepeatingVibration()
                    finish()
                }
            }
        }
        val filterAnswered = IntentFilter(ACTION_CALL_ANSWERED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callAnsweredReceiver, filterAnswered, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(callAnsweredReceiver, filterAnswered)
        }

        // Назад: экран уходит в фон (уведомление не показываем — только нативный экран при входящем).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // Уведомление не показываем ни в шторке, ни в строке состояния
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
    }

    /**
     * Домой / Недавние: экран уходит в фон без завершения (принять/отклонить — в приложении).
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        moveTaskToBack(true)
    }

    override fun onDestroy() {
        LiviOngoingCallHelper.clearOngoingCall(applicationContext)
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        callCanceledReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callCanceledReceiver = null
        callAnsweredReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callAnsweredReceiver = null
        stopRepeatingVibration()
        super.onDestroy()
    }

    private fun startRepeatingVibration() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        if (!vibrator.hasVibrator()) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val pattern = longArrayOf(0, 500, 200, 500)
                val effect = VibrationEffect.createWaveform(pattern, 0)
                vibrator.vibrate(effect)
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(longArrayOf(0, 500, 200, 500), 0)
            }
        } catch (e: Exception) {
            android.util.Log.w(TAG, "startRepeatingVibration failed", e)
        }
    }

    private fun stopRepeatingVibration() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        try {
            vibrator.cancel()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "stopRepeatingVibration failed", e)
        }
    }

    /**
     * Отклонение: по HTTP без открытия приложения (нет мерцания, инициатор сразу получает call:declined).
     * Если installId/serverUrl нет — fallback на livi://decline-call.
     */
    private fun declineCallFromNative(callId: String) {
        val prefs = applicationContext.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
        val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
        val serverUrl = prefs.getString(LiviAppModule.KEY_SERVER_URL, null)?.takeIf { it.isNotBlank() }
        if (installId != null && serverUrl != null) {
            Thread {
                try {
                    val url = URL("$serverUrl/api/calls/decline")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("x-install-id", installId)
                    conn.doOutput = true
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.outputStream.use { os ->
                        os.write("{\"callId\":\"${callId.replace("\"", "\\\"")}\"}".toByteArray(Charsets.UTF_8))
                    }
                    val code = conn.responseCode
                    if (code !in 200..299) {
                        android.util.Log.w(TAG, "decline HTTP $code")
                    }
                    conn.disconnect()
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "decline HTTP failed", e)
                }
            }.start()
            finish()
        } else {
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
        private const val TAG = "IncomingCallActivity"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        const val ACTION_CALL_ANSWERED = "com.kolt12max.livi.CALL_ANSWERED"
    }
}
