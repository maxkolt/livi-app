package com.kolt12max.livi

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.VibrationAttributes
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
    private var ringtonePlayer: MediaPlayer? = null
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    private var closeHandled = false
    private var incomingShownReported = false
    private var incomingShownInFlight = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val callIdFromIntent = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        // FCM call_canceled может запустить активность с флагом «только закрыть» (приложение в фоне/убито — broadcast не дошёл)
        if (intent.getBooleanExtra(EXTRA_JUST_CLOSE, false) && callIdFromIntent.isNotEmpty()) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            closeIncomingScreen(callIdFromIntent)
            return
        }
        // КРИТИЧНО: Если звонок уже отменён/завершён (пущ пришёл с опозданием или пользователь открыл уведомление позже) — не показывать экран
        if (callIdFromIntent.isNotEmpty() && EndedCallIds.isEnded(this, callIdFromIntent)) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            val shown = Intent(IncomingCallForegroundService.ACTION_INCOMING_CALL_ACTIVITY_SHOWN).apply {
                setPackage(packageName)
                putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callIdFromIntent)
            }
            sendBroadcast(shown)
            closeIncomingScreen()
            return
        }
        isAlive = true
        android.util.Log.e(TAG, "IncomingCallActivity onCreate: isAlive=true isInForeground=(set in onResume) callId=$callIdFromIntent")
        // Убираем уведомление полностью — при входящем звонке только нативный экран, без шторки и баннера
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        // Сообщаем IncomingCallForegroundService, что экран открыт — сервис снимет уведомление и остановится (важно для заблокированного/домашнего экрана)
        if (callIdFromIntent.isNotEmpty()) {
            val shown = Intent(IncomingCallForegroundService.ACTION_INCOMING_CALL_ACTIVITY_SHOWN).apply {
                setPackage(packageName)
                putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callIdFromIntent)
            }
            sendBroadcast(shown)
            // Fallback: на некоторых устройствах broadcast может уйти до регистрации receiver в сервисе.
            // Повторяем через небольшую задержку, чтобы гарантированно снять heads-up/FGS.
            Handler(Looper.getMainLooper()).postDelayed({
                try { sendBroadcast(shown) } catch (_: Exception) {}
            }, 250)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        setContentView(R.layout.activity_incoming_call)

        startCallRingtone()
        startRepeatingVibration()
        currentCallId = callIdFromIntent
        val callId = currentCallId
        val from = intent.getStringExtra(EXTRA_FROM) ?: ""
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        LiviOngoingCallHelper.setIncomingCall(this, callId, from, fromNick)
        reportIncomingShownFromNative(callId)
        scheduleIncomingTimeout(callId)

        findViewById<TextView>(R.id.caller_name).text = if (fromNick.isNotEmpty()) fromNick else getString(R.string.incoming_call_unknown)
        findViewById<TextView>(R.id.call_subtitle).text = getString(R.string.incoming_call_title)

        findViewById<ImageButton>(R.id.btn_accept).setOnClickListener {
            clearIncomingTimeout()
            stopCallRingtone()
            stopRepeatingVibration()
            val answerUri = "livi://answer-call?callId=${Uri.encode(callId)}&from=${Uri.encode(from)}&fromNick=${URLEncoder.encode(fromNick, StandardCharsets.UTF_8.toString())}"
            startMainWithDeepLink(answerUri)
            closeIncomingScreen()
        }

        findViewById<ImageButton>(R.id.btn_decline).setOnClickListener {
            clearIncomingTimeout()
            stopCallRingtone()
            stopRepeatingVibration()
            LiviAppModule.emitIncomingCallDeclinedByUser(callId)
            EndedCallIds.add(this, callId)
            isInForeground = false
            android.util.Log.e(TAG, "IncomingCallActivity Decline pressed: isInForeground=false callId=$callId sending ACTION_INCOMING_CALL_DECLINED so FGS stops")
            val declinedIntent = Intent(IncomingCallForegroundService.ACTION_INCOMING_CALL_DECLINED).apply {
                setPackage(packageName)
                putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
            }
            sendBroadcast(declinedIntent)
            declineCallFromNative(callId)
        }

        callCanceledReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val canceledCallId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (canceledCallId == currentCallId) {
                    closeIncomingScreen()
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
                    closeIncomingScreen()
                }
            }
        }
        val filterAnswered = IntentFilter(ACTION_CALL_ANSWERED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callAnsweredReceiver, filterAnswered, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(callAnsweredReceiver, filterAnswered)
        }

        // Назад: экран уходит в шторку уведомлений (FGS с уведомлением, тап — вернуться на экран входящего).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (currentCallId.isNotEmpty()) {
                    val from = intent.getStringExtra(EXTRA_FROM) ?: ""
                    val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
                    val serviceIntent = Intent(this@IncomingCallActivity, IncomingCallForegroundService::class.java).apply {
                        putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, currentCallId)
                        putExtra(IncomingCallForegroundService.EXTRA_FROM, from)
                        putExtra(IncomingCallForegroundService.EXTRA_FROM_NICK, fromNick)
                        putExtra(IncomingCallForegroundService.EXTRA_SILENT_NOTIFICATION, true)
                        putExtra(IncomingCallForegroundService.EXTRA_MINIMIZED, true)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(serviceIntent)
                    } else {
                        startService(serviceIntent)
                    }
                }
                moveTaskToBack(true)
            }
        })
    }

    override fun onResume() {
        super.onResume()
        isInForeground = true
        android.util.Log.e(TAG, "IncomingCallActivity onResume: isInForeground=true callId=$currentCallId")
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        reportIncomingShownFromNative(currentCallId)
    }

    override fun onPause() {
        super.onPause()
        isInForeground = false
        android.util.Log.e(TAG, "IncomingCallActivity onPause: isInForeground=false callId=$currentCallId")
    }

    /**
     * Домой / Недавние: экран уходит в фон без завершения (принять/отклонить — в приложении).
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        moveTaskToBack(true)
    }

    override fun onDestroy() {
        isInForeground = false
        isAlive = false
        android.util.Log.e(TAG, "IncomingCallActivity onDestroy: isInForeground=false isAlive=false callId=$currentCallId")
        LiviOngoingCallHelper.clearOngoingCall(applicationContext)
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        callCanceledReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callCanceledReceiver = null
        callAnsweredReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callAnsweredReceiver = null
        clearIncomingTimeout()
        stopCallRingtone()
        stopRepeatingVibration()
        super.onDestroy()
    }

    /** Вибрация звонка (Настройки → Вибрация звонка): USAGE_RINGTONE на API 33+, иначе обычный паттерн. */
    private fun startRepeatingVibration() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        if (!vibrator.hasVibrator()) return
        try {
            val pattern = longArrayOf(0, 500, 200, 500) // пауза, вибрация, пауза, вибрация — повтор
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val effect = VibrationEffect.createWaveform(pattern, 0)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val attrs = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_RINGTONE)
                    vibrator.vibrate(effect, attrs)
                } else {
                    vibrator.vibrate(effect)
                }
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, 0)
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
     * Если installId/serverUrl нет или HTTP неуспешен — fallback livi://decline-call (JS/сокет дожмут отмену).
     * Важно: не вызывать finish() до ответа HTTP, иначе при ошибке сети/401 инициатор остаётся в звонке.
     */
    private fun declineCallFromNative(callId: String) {
        val prefs = applicationContext.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
        val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
        val serverUrl = LiviAppModule.resolveServerBaseUrl(applicationContext)
        val userIdHeader = prefs.getString(LiviAppModule.KEY_USER_ID_FOR_DECLINE, null)?.takeIf { it.isNotBlank() }
        val declineUri = "livi://decline-call?callId=${Uri.encode(callId)}"
        if (installId != null && serverUrl != null) {
            Thread {
                var httpOk = false
                try {
                    val url = URL("$serverUrl/api/calls/decline")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("x-install-id", installId)
                    if (userIdHeader != null) {
                        conn.setRequestProperty("x-user-id", userIdHeader)
                    }
                    conn.doOutput = true
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.outputStream.use { os ->
                        os.write("{\"callId\":\"${callId.replace("\"", "\\\"")}\"}".toByteArray(Charsets.UTF_8))
                    }
                    val code = conn.responseCode
                    httpOk = code in 200..299
                    if (!httpOk) {
                        android.util.Log.e(TAG, "decline HTTP failed code=$code callId=$callId (will try deep link fallback)")
                    }
                    conn.disconnect()
                } catch (e: Exception) {
                    android.util.Log.e(TAG, "decline HTTP exception callId=$callId (will try deep link fallback)", e)
                }
                runOnUiThread {
                    if (!httpOk) {
                        try {
                            startMainWithDeepLink(declineUri)
                        } catch (e: Exception) {
                            android.util.Log.e(TAG, "decline deep link fallback failed", e)
                        }
                    }
                    finish()
                }
            }.start()
        } else {
            android.util.Log.w(TAG, "decline: missing installId or serverUrl, using deep link")
            startMainWithDeepLink(declineUri)
            finish()
        }
    }

    /** Отправить backend-ack: входящий экран реально показан (работает даже при неактивном/спящем JS). */
    private fun reportIncomingShownFromNative(callId: String) {
        if (incomingShownReported || incomingShownInFlight || callId.isBlank()) return
        val prefs = applicationContext.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
        val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
        val serverUrl = LiviAppModule.resolveServerBaseUrl(applicationContext)
        val userIdHeader = prefs.getString(LiviAppModule.KEY_USER_ID_FOR_DECLINE, null)?.takeIf { it.isNotBlank() }
        if (installId == null || serverUrl == null) return
        incomingShownInFlight = true
        Thread {
            try {
                var ok = false
                val payload = "{\"callId\":\"${callId.replace("\"", "\\\"")}\"}"
                val endpoints = listOf(
                    "$serverUrl/api/calls/incoming-shown",
                    "$serverUrl/calls/incoming-shown"
                )
                for (endpoint in endpoints) {
                    try {
                        val url = URL(endpoint)
                        val conn = url.openConnection() as java.net.HttpURLConnection
                        conn.requestMethod = "POST"
                        conn.setRequestProperty("Content-Type", "application/json")
                        conn.setRequestProperty("x-install-id", installId)
                        if (userIdHeader != null) conn.setRequestProperty("x-user-id", userIdHeader)
                        conn.doOutput = true
                        conn.connectTimeout = 5000
                        conn.readTimeout = 5000
                        conn.outputStream.use { os ->
                            os.write(payload.toByteArray(Charsets.UTF_8))
                        }
                        val code = conn.responseCode
                        conn.disconnect()
                        if (code in 200..299) {
                            ok = true
                            break
                        }
                        // 404 на втором endpoint бесполезен, а 401/403 не ретраим.
                        if (code == 401 || code == 403 || code == 400) break
                    } catch (_: Exception) {
                        // Пробуем следующий endpoint/попытку.
                    }
                }
                runOnUiThread {
                    incomingShownInFlight = false
                    if (ok) {
                        incomingShownReported = true
                    } else {
                        android.util.Log.w(TAG, "incoming-shown HTTP failed callId=$callId")
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    incomingShownInFlight = false
                    android.util.Log.w(TAG, "incoming-shown HTTP exception callId=$callId", e)
                }
            }
        }.start()
    }

    private fun startMainWithDeepLink(deepLink: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
            setClassName(applicationContext, "com.kolt12max.livi.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        startActivity(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_JUST_CLOSE, false)) {
            val cid = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
            if (cid.isNotEmpty()) {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            }
            closeIncomingScreen(cid.ifEmpty { null })
        }
    }

    override fun finish() {
        super.finish()
        // Как и у OutgoingCallActivity, убираем системную анимацию закрытия.
        // Иначе при возврате к уже открытому Home Android рисует "доезд" окна
        // отдельной singleInstance-activity, что выглядит как двойной показ экрана.
        overridePendingTransition(0, 0)
    }

    /** Системная мелодия звонка (Настройки → Мелодия звонка), STREAM_RING, зациклена. */
    private fun startCallRingtone() {
        val uri: Uri? = try {
            RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "startCallRingtone: getActualDefaultRingtoneUri failed", e)
            null
        }
        if (uri == null) return
        try {
            val player = MediaPlayer().apply {
                setDataSource(applicationContext, uri)
                setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                isLooping = true
                prepare()
                start()
            }
            ringtonePlayer = player
        } catch (e: Exception) {
            android.util.Log.w(TAG, "startCallRingtone: play failed", e)
        }
    }

    private fun stopCallRingtone() {
        try {
            ringtonePlayer?.apply {
                if (isPlaying) stop()
                release()
            }
            ringtonePlayer = null
        } catch (e: Exception) {
            android.util.Log.w(TAG, "stopCallRingtone failed", e)
        }
    }

    /**
     * Локальный fail-safe: если сокет/FCM не доставили call:timeout или call_canceled,
     * всё равно останавливаем рингтон и закрываем экран через тот же 20-секундный интервал.
     */
    private fun scheduleIncomingTimeout(callId: String) {
        if (callId.isEmpty()) return
        clearIncomingTimeout()
        timeoutRunnable = Runnable {
            try {
                EndedCallIds.add(this, callId)
                val cancelIntent = Intent(LiviFirebaseMessagingService.ACTION_CALL_CANCELED).apply {
                    setPackage(packageName)
                    putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
                }
                sendBroadcast(cancelIntent)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "scheduleIncomingTimeout broadcast failed", e)
            }
            stopCallRingtone()
            stopRepeatingVibration()
            isInForeground = false
            android.util.Log.e(TAG, "IncomingCallActivity timeout 20s: isInForeground=false calling finish() callId=$callId")
            finish()
        }
        timeoutHandler.postDelayed(timeoutRunnable!!, INCOMING_TIMEOUT_MS)
    }

    private fun clearIncomingTimeout() {
        timeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
        timeoutRunnable = null
    }

    private fun closeIncomingScreen(callIdToEnd: String? = null) {
        android.util.Log.e(TAG, "IncomingCallActivity closeIncomingScreen: callIdToEnd=$callIdToEnd closeHandled=$closeHandled isFinishing=$isFinishing isDestroyed=$isDestroyed")
        callIdToEnd?.takeIf { it.isNotEmpty() }?.let { EndedCallIds.add(this, it) }
        clearIncomingTimeout()
        stopCallRingtone()
        stopRepeatingVibration()
        if (closeHandled || isFinishing || isDestroyed) return
        closeHandled = true
        isInForeground = false
        android.util.Log.e(TAG, "IncomingCallActivity closeIncomingScreen: setting isInForeground=false, calling finish()")
        finish()
    }

    companion object {
        private const val TAG = "IncomingCallActivity"
        private const val INCOMING_TIMEOUT_MS = 20_000L
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        /** FCM call_canceled запускает активность с этим флагом, чтобы закрыть экран без показа UI (приложение в фоне/убито). */
        const val EXTRA_JUST_CLOSE = "just_close"
        const val ACTION_CALL_ANSWERED = "com.kolt12max.livi.CALL_ANSWERED"
        /** true пока нативный экран входящего на экране (защита от heads-up поверх него). */
        @JvmField
        var isInForeground: Boolean = false
        /** true пока экземпляр IncomingCallActivity существует, даже если он ушёл в фон. */
        @JvmField
        var isAlive: Boolean = false
    }
}
