package com.kolt12max.livi

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.Ringtone
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
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.view.WindowManager
import android.view.MotionEvent
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.net.URL

/**
 * Полноэкранный экран входящего звонка (full-screen intent, как WhatsApp/Telegram).
 * Показывается поверх блокировки и других приложений при FCM-пуше о звонке.
 * Принять → MainActivity с extras (без livi:// — dev client не перехватывает) → JS открывает VideoCall.
 * Отклонить → по HTTP на сервер (без открытия приложения), иначе livi://decline-call.
 * При отмене инициатором приходит FCM call_canceled → broadcast → finish() без мельканий.
 */
class IncomingCallActivity : AppCompatActivity() {

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

    private var currentCallId: String = ""
    private var callCanceledReceiver: BroadcastReceiver? = null
    private var callAnsweredReceiver: BroadcastReceiver? = null
    private var stopRemoteRingtoneReceiver: BroadcastReceiver? = null
    private var ringtonePlayer: MediaPlayer? = null
    /** Системный Ringtone (API 28+ с loop) — на части OEM/Samsung лучше выходит на звонок при keyguard, чем сырой MediaPlayer. */
    private var systemRingtone: Ringtone? = null
    private var ringtoneAudioManager: AudioManager? = null
    private var ringtoneAudioFocusRequest: AudioFocusRequest? = null
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    private var ringtoneVerifyRunnable: Runnable? = null
    /** Проверки «Activity реально играет» перед заглушением FGS — иначе на keyguard глушим единственный живой плеер. */
    private val pendingStopFgsAudibleChecks = mutableListOf<Runnable>()
    private var closeHandled = false
    private var incomingShownReported = false
    private var incomingShownInFlight = false
    private var incomingDeadlineAtMs: Long = 0L
    private var closingForCompletion: Boolean = false
    private var minimizedToShade: Boolean = false
    private var acceptInProgress: Boolean = false
    /** После закрытия входящего (отмена/таймаут) — вернуть Main без debounce. */
    private var mainReturnScheduled = false
    /** true только если входящий открыли поверх уже активного приложения (не с лаунчера/lock screen). */
    private var returnMainOnDismiss = false

    override fun onCreate(savedInstanceState: Bundle?) {
        ScreenOrientationHelper.applyPhonePortraitTabletAny(this)
        super.onCreate(savedInstanceState)
        EdgeToEdgeHelper.apply(this)
        returnMainOnDismiss = intent.getBooleanExtra(EXTRA_RETURN_MAIN_ON_DISMISS, false)
        val callIdFromIntent = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        // FCM call_canceled может запустить активность с флагом «только закрыть» (приложение в фоне/убито — broadcast не дошёл)
        if (intent.getBooleanExtra(EXTRA_JUST_CLOSE, false) && callIdFromIntent.isNotEmpty()) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            closeIncomingScreen(callIdFromIntent, bringMainOnDismiss = false)
            return
        }
        // Звонок уже отменён или ring window истёк (лаунчер/FGS с устаревшим callId).
        if (callIdFromIntent.isNotEmpty() && LiviOngoingCallHelper.shouldSuppressStaleIncoming(this, callIdFromIntent)) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            val shown = Intent(IncomingCallForegroundService.ACTION_INCOMING_CALL_ACTIVITY_SHOWN).apply {
                setPackage(packageName)
                putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callIdFromIntent)
            }
            sendBroadcast(shown)
            LiviOngoingCallHelper.clearOngoingCallIfMatches(this, callIdFromIntent)
            closeIncomingScreen(callIdFromIntent)
            return
        }
        currentCallId = callIdFromIntent
        if (callIdFromIntent.isNotEmpty()) {
            activeCallId = callIdFromIntent
        }
        registerCallCanceledReceiverIfNeeded()
        if (closeIfCallAlreadyEnded(callIdFromIntent)) {
            return
        }
        isAlive = true
        android.util.Log.e(TAG, "IncomingCallActivity onCreate: isAlive=true isInForeground=(set in onResume) callId=$callIdFromIntent")
        // Сначала broadcast: FGS делает stopForeground(DETACH) и оставляет уведомление в шторке (без отмены — иначе ломаем
        // foreground до detach и на части OEM обрывается рингтон FGS/Activity).
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
        window.setFormat(PixelFormat.RGBA_8888)
        setContentView(R.layout.activity_incoming_call)
        findViewById<View>(R.id.incoming_call_content)?.let { EdgeToEdgeHelper.applySystemBarInsets(it) }
        // Пауза + transient media focus на время входящего/звонка (рингтон остаётся на STREAM_RING).
        window?.decorView?.post {
            try {
                LiviAppModule.beginBackgroundMediaSuppressionStatic(applicationContext)
            } catch (_: Exception) {}
        } ?: try {
            LiviAppModule.beginBackgroundMediaSuppressionStatic(applicationContext)
        } catch (_: Exception) {}
        // Качелька громкости регулирует поток звонка, а не медиа.
        @Suppress("DEPRECATION")
        volumeControlStream = AudioManager.STREAM_RING

        // До рингтона: слушатель «снять мелодию с Activity», когда стартует рингтон ConnectionService/CallKeep (иначе два MediaPlayer).
        stopRemoteRingtoneReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                try {
                    stopCallRingtone()
                    stopRepeatingVibration()
                } catch (_: Exception) {}
            }
        }
        val filterStopRing = IntentFilter(LiviAppModule.ACTION_STOP_INCOMING_ACTIVITY_RINGTONE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stopRemoteRingtoneReceiver, filterStopRing, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(stopRemoteRingtoneReceiver, filterStopRing)
        }

        startCallRingtone()
        startRepeatingVibration()
        val callId = currentCallId
        val from = intent.getStringExtra(EXTRA_FROM) ?: ""
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        LiviOngoingCallHelper.setIncomingCall(this, callId, from, fromNick)
        reportIncomingShownFromNative(callId)
        scheduleIncomingTimeout(callId)

        findViewById<TextView>(R.id.caller_name).text = if (fromNick.isNotEmpty()) fromNick else getString(R.string.incoming_call_unknown)
        val hasVideo = intent.getBooleanExtra(EXTRA_HAS_VIDEO, true)
        findViewById<TextView>(R.id.call_subtitle).text =
            getString(if (hasVideo) R.string.incoming_call_title else R.string.incoming_call_title_audio)

        val acceptButton = findViewById<ImageButton>(R.id.btn_accept)
        val declineButton = findViewById<ImageButton>(R.id.btn_decline)
        installPressFeedback(acceptButton)
        installPressFeedback(declineButton)

        acceptButton.setOnClickListener {
            if (acceptInProgress) return@setOnClickListener
            acceptInProgress = true
            acceptButton.isEnabled = false
            declineButton.isEnabled = false
            stopCallRingtone()
            stopRepeatingVibration()
            LiviAppModule.setPendingAnswerCall(callId, from, fromNick)
            val deliveredToJs = LiviAppModule.tryDeliverPendingAnswerToJs()
            // Incoming = singleInstance. Без подъёма Main после finish() остаётся лаунчер.
            if (!deliveredToJs) {
                android.util.Log.i(TAG, "accept: React not alive — startMainForAnswerCall callId=$callId")
                startMainForAnswerCall(callId, from, fromNick)
            } else {
                android.util.Log.i(TAG, "accept: JS handling — bring Main task to front (no re-stash) callId=$callId")
                LiviAppModule.bringMainToFrontImmediate(applicationContext)
            }
            // Не закрываем экран сразу:
            // закрытие подтверждается ACTION_CALL_ANSWERED из JS после фактического старта флоу accept.
            // Это убирает гонку, когда экран входящего исчезает, но VideoCall ещё не открылся.
        }

        declineButton.setOnClickListener {
            clearIncomingTimeout()
            stopCallRingtone()
            stopRepeatingVibration()
            closingForCompletion = true
            try {
                LiviAppModule.releaseBackgroundMediaSuppressionStatic(applicationContext)
            } catch (_: Exception) {}
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

        // После ответа JS шлёт broadcast (deep link или pending extras) — закрываем экран.
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
                minimizeIncomingToShade()
                moveTaskToBack(true)
            }
        })
    }

    override fun onResume() {
        super.onResume()
        if (currentCallId.isNotEmpty() && LiviOngoingCallHelper.shouldSuppressStaleIncoming(this, currentCallId)) {
            closeIncomingScreen(currentCallId)
            return
        }
        isInForeground = true
        android.util.Log.e(TAG, "IncomingCallActivity onResume: isInForeground=true callId=$currentCallId")
        reportIncomingShownFromNative(currentCallId)
    }

    private fun registerCallCanceledReceiverIfNeeded() {
        if (callCanceledReceiver != null) return
        callCanceledReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val canceledCallId = intent?.getStringExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID) ?: return
                if (canceledCallId == currentCallId) {
                    // Не поднимаем Main через startActivity — finish Incoming без REORDER,
                    // иначе поверх Home мелькает «вторая страница».
                    closeIncomingScreen(bringMainOnDismiss = false)
                }
            }
        }
        val filter = IntentFilter(LiviFirebaseMessagingService.ACTION_CALL_CANCELED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callCanceledReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(callCanceledReceiver, filter)
        }
    }

    /** true если экран закрыт как уже отменённый/завершённый. */
    private fun closeIfCallAlreadyEnded(callId: String): Boolean {
        if (callId.isEmpty() || !LiviOngoingCallHelper.shouldSuppressStaleIncoming(this, callId)) return false
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        closeIncomingScreen(callId)
        return true
    }

    override fun onPause() {
        super.onPause()
        isInForeground = false
        android.util.Log.e(TAG, "IncomingCallActivity onPause: isInForeground=false callId=$currentCallId")
    }

    /**
     * Домой / Недавние: экран уходит в фон без завершения (принять/отклонить — в приложении).
     * При accept Main поднимается поверх — не трактуем это как Home и не уводим задачу «в никуда».
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (acceptInProgress || closingForCompletion || closeHandled) {
            android.util.Log.i(TAG, "onUserLeaveHint: skip moveTaskToBack (accept/close in progress)")
            return
        }
        minimizeIncomingToShade()
        moveTaskToBack(true)
    }

    override fun onDestroy() {
        isInForeground = false
        isAlive = false
        if (activeCallId == currentCallId) {
            activeCallId = ""
        }
        android.util.Log.e(TAG, "IncomingCallActivity onDestroy: isInForeground=false isAlive=false callId=$currentCallId")
        if (closingForCompletion) {
            LiviOngoingCallHelper.clearOngoingCall(applicationContext)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        } else if (minimizedToShade) {
            // Keep ongoing incoming state + shade notification so user can reopen screen.
            minimizeIncomingToShade()
        }
        callCanceledReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callCanceledReceiver = null
        callAnsweredReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        callAnsweredReceiver = null
        stopRemoteRingtoneReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        stopRemoteRingtoneReceiver = null
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

    private fun startMainForAnswerCall(callId: String, from: String, fromNick: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            putExtra(MainActivity.EXTRA_PENDING_ANSWER_CALL_ID, callId)
            putExtra(MainActivity.EXTRA_PENDING_ANSWER_FROM, from)
            putExtra(MainActivity.EXTRA_PENDING_ANSWER_FROM_NICK, fromNick)
            putExtra(MainActivity.EXTRA_INCOMING_ANSWER_COVER, true)
        }
        MainActivity.armIncomingAnswerCover = true
        startActivity(intent)
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
        setIntent(intent)
        if (intent.hasExtra(EXTRA_RETURN_MAIN_ON_DISMISS)) {
            returnMainOnDismiss = intent.getBooleanExtra(EXTRA_RETURN_MAIN_ON_DISMISS, false)
        }
        if (intent.getBooleanExtra(EXTRA_JUST_CLOSE, false)) {
            val cid = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
            if (cid.isNotEmpty()) {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
            }
            closeIncomingScreen(cid.ifEmpty { null }, bringMainOnDismiss = false)
        }
    }

    override fun finish() {
        super.finish()
        // Как и у OutgoingCallActivity, убираем системную анимацию закрытия.
        // Иначе при возврате к уже открытому Home Android рисует "доезд" окна
        // отдельной singleInstance-activity, что выглядит как двойной показ экрана.
        overridePendingTransition(0, 0)
    }

    /** Системная мелодия звонка (Настройки → Мелодия звонка), зациклена до ответа/отмены/таймаута 20с. */
    private fun startCallRingtone() {
        try {
            LiviAppModule.stopFgsHandoffForIncomingCallActivity(applicationContext)
        } catch (_: Exception) {}
        val uri: Uri? = try {
            RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "startCallRingtone: getActualDefaultRingtoneUri failed", e)
            null
        }
        if (uri == null) {
            android.util.Log.w(TAG, "startCallRingtone: default ringtone uri is null")
            // Оставляем рингтон FGS/CallKeep — не глушим общий плеер.
            return
        }
        // НЕ вызываем stopRingtonePlayerForCallKeepOnly() до успешного play() в Activity:
        // на заблокированном экране post(play) срабатывает с задержкой; преждевременная остановка FGS
        // оставляет тишину до второго звонка. Дубль снимаем в playIncomingRingtone после старта.
        // После keyguard/full-screen intent аудиополитика иногда глушит старт в onCreate до готовности окна.
        val start = Runnable { playIncomingRingtone(uri) }
        val decor = window?.decorView
        if (decor != null) {
            decor.post(start)
        } else {
            timeoutHandler.post(start)
        }
        // Повтор, если OEM/ключ экрана «съели» первый старт рингтона.
        ringtoneVerifyRunnable?.let { timeoutHandler.removeCallbacks(it) }
        ringtoneVerifyRunnable = Runnable {
            ringtoneVerifyRunnable = null
            if (isFinishing) return@Runnable
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed) return@Runnable
            val playing = try {
                when {
                    systemRingtone != null -> systemRingtone!!.isPlaying
                    ringtonePlayer != null -> ringtonePlayer!!.isPlaying
                    else -> false
                }
            } catch (_: Exception) {
                false
            }
            if (!playing) {
                android.util.Log.w(TAG, "startCallRingtone: verify not playing, retry playIncomingRingtone")
                stopCallRingtone()
                playIncomingRingtone(uri)
            } else {
                LiviAppModule.stopRingtonePlayerForCallKeepOnly()
                for (r in pendingStopFgsAudibleChecks) {
                    timeoutHandler.removeCallbacks(r)
                }
                pendingStopFgsAudibleChecks.clear()
            }
        }
        timeoutHandler.postDelayed(ringtoneVerifyRunnable!!, 900)
    }

    private fun playIncomingRingtone(uri: Uri) {
        if (isFinishing) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed) return

        LiviAppModule.ensureIncomingRingtoneAudioMode(applicationContext)

        // API 28+: встроенный Ringtone с loop — тот же путь, что превью в настройках; на Samsung при блокировке надёжнее MediaPlayer.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                val rt = RingtoneManager.getRingtone(applicationContext, uri)
                if (rt != null) {
                    try {
                        rt.stop()
                    } catch (_: Exception) {}
                    val usage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        AUDIO_USAGE_RINGTONE
                    } else {
                        android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE
                    }
                    rt.audioAttributes = android.media.AudioAttributes.Builder()
                        .setUsage(usage)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                    rt.isLooping = true
                    rt.play()
                    systemRingtone = rt
                    scheduleStopFgsWhenActivityAudible()
                    return
                }
            } catch (e: Exception) {
                android.util.Log.w(TAG, "playIncomingRingtone: Ringtone failed, trying MediaPlayer", e)
            }
        }

        acquireRingtoneAudioFocus()
        val usage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            AUDIO_USAGE_RINGTONE
        } else {
            android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE
        }
        try {
            val player = MediaPlayer().apply {
                setDataSource(applicationContext, uri)
                setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(usage)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                isLooping = true
                prepare()
                start()
            }
            ringtonePlayer = player
            scheduleStopFgsWhenActivityAudible()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "playIncomingRingtone: MediaPlayer failed", e)
            releaseRingtoneAudioFocus()
            try {
                LiviAppModule.clearIncomingRingtoneAudioMode(applicationContext)
            } catch (_: Exception) {}
        }
    }

    private fun acquireRingtoneAudioFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        ringtoneAudioManager = am
        val usage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            AUDIO_USAGE_RINGTONE
        } else {
            android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE
        }
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = android.media.AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            // TRANSIENT_EXCLUSIVE на части устройств с keyguard режет звук рингтона; для входящего достаточно TRANSIENT.
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener { }
                .build()
            ringtoneAudioFocusRequest = req
            am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_RING, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        if (!ok) {
            android.util.Log.w(TAG, "acquireRingtoneAudioFocus: not granted, still trying ringtone playback")
        }
    }

    private fun releaseRingtoneAudioFocus() {
        val am = ringtoneAudioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ringtoneAudioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
                ringtoneAudioFocusRequest = null
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(null)
            }
        } catch (_: Exception) {}
        ringtoneAudioManager = null
    }

    private fun stopCallRingtone() {
        try {
            systemRingtone?.stop()
            systemRingtone = null
        } catch (e: Exception) {
            android.util.Log.w(TAG, "stopCallRingtone: system Ringtone", e)
        }
        try {
            ringtonePlayer?.apply {
                if (isPlaying) stop()
                release()
            }
            ringtonePlayer = null
        } catch (e: Exception) {
            android.util.Log.w(TAG, "stopCallRingtone failed", e)
        }
        releaseRingtoneAudioFocus()
        // Режим AudioManager сбрасываем в LiviAppModule.stopIncomingCallRingtoneAndVibrationStatic (ответ/отклонение/FGS cleanup),
        // чтобы не глушить рингтон FGS, если Activity не смогла взять звук на себя (uri == null / сбой OEM).
    }

    /**
     * Локальный fail-safe: если сокет/FCM не доставили call:timeout или call_canceled,
     * всё равно останавливаем рингтон и закрываем экран через тот же 20-секундный интервал.
     */
    private fun scheduleIncomingTimeout(callId: String) {
        if (callId.isEmpty()) return
        clearIncomingTimeout()
        incomingDeadlineAtMs = System.currentTimeMillis() + INCOMING_TIMEOUT_MS
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
            val fromUserId = intent.getStringExtra(EXTRA_FROM) ?: ""
            val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
            if (fromUserId.isNotEmpty()) {
                try {
                    LiviFirebaseMessagingService.notifyMissedCallFromPush(applicationContext, callId, fromUserId, fromNick)
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "scheduleIncomingTimeout missed notification failed", e)
                }
            }
            stopCallRingtone()
            stopRepeatingVibration()
            closingForCompletion = true
            isInForeground = false
            try {
                LiviAppModule.releaseBackgroundMediaSuppressionStatic(applicationContext)
            } catch (_: Exception) {}
            LiviOngoingCallHelper.clearOngoingCall(applicationContext)
            android.util.Log.e(TAG, "IncomingCallActivity timeout 20s: isInForeground=false calling finish() callId=$callId")
            finish()
        }
        timeoutHandler.postDelayed(timeoutRunnable!!, INCOMING_TIMEOUT_MS)
    }

    private fun remainingIncomingMs(): Long {
        if (incomingDeadlineAtMs <= 0L) return INCOMING_TIMEOUT_MS
        return (incomingDeadlineAtMs - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    private fun minimizeIncomingToShade() {
        if (closingForCompletion) return
        val callId = currentCallId
        if (callId.isEmpty()) return
        val remainingMs = remainingIncomingMs()
        if (remainingMs <= 0L) return
        if (EndedCallIds.isEnded(applicationContext, callId)) return
        if (LiviOngoingCallHelper.shouldSuppressStaleIncoming(applicationContext, callId)) return
        minimizedToShade = true
        val from = intent.getStringExtra(EXTRA_FROM) ?: ""
        val fromNick = intent.getStringExtra(EXTRA_FROM_NICK) ?: ""
        val serviceIntent = Intent(this, IncomingCallForegroundService::class.java).apply {
            putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
            putExtra(IncomingCallForegroundService.EXTRA_FROM, from)
            putExtra(IncomingCallForegroundService.EXTRA_FROM_NICK, fromNick)
            putExtra(IncomingCallForegroundService.EXTRA_SILENT_NOTIFICATION, true)
            putExtra(IncomingCallForegroundService.EXTRA_MINIMIZED, true)
            putExtra(IncomingCallForegroundService.EXTRA_REMAINING_TIMEOUT_MS, remainingMs)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        } catch (_: Exception) {}
    }

    private fun clearIncomingTimeout() {
        timeoutRunnable?.let { timeoutHandler.removeCallbacks(it) }
        timeoutRunnable = null
        ringtoneVerifyRunnable?.let { timeoutHandler.removeCallbacks(it) }
        ringtoneVerifyRunnable = null
        for (r in pendingStopFgsAudibleChecks) {
            timeoutHandler.removeCallbacks(r)
        }
        pendingStopFgsAudibleChecks.clear()
    }

    private fun isActivityRingtoneAudible(): Boolean {
        return try {
            when {
                systemRingtone != null -> systemRingtone!!.isPlaying
                ringtonePlayer != null -> ringtonePlayer!!.isPlaying
                else -> false
            }
        } catch (_: Exception) {
            false
        }
    }

    /** Глушим FGS-плеер только когда рингтон Activity реально идёт; иначе оставляем звук FGS. */
    private fun tryStopFgsIfActivityRinging() {
        if (isFinishing) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed) return
        if (isActivityRingtoneAudible()) {
            LiviAppModule.stopRingtonePlayerForCallKeepOnly()
            for (r in pendingStopFgsAudibleChecks) {
                timeoutHandler.removeCallbacks(r)
            }
            pendingStopFgsAudibleChecks.clear()
        }
    }

    private fun scheduleStopFgsWhenActivityAudible() {
        for (r in pendingStopFgsAudibleChecks) {
            timeoutHandler.removeCallbacks(r)
        }
        pendingStopFgsAudibleChecks.clear()
        val delays = longArrayOf(220L, 500L, 950L)
        for (d in delays) {
            val r = Runnable { tryStopFgsIfActivityRinging() }
            pendingStopFgsAudibleChecks.add(r)
            timeoutHandler.postDelayed(r, d)
        }
    }

    private fun closeIncomingScreen(callIdToEnd: String? = null, bringMainOnDismiss: Boolean? = null) {
        android.util.Log.e(TAG, "IncomingCallActivity closeIncomingScreen: callIdToEnd=$callIdToEnd closeHandled=$closeHandled isFinishing=$isFinishing isDestroyed=$isDestroyed bringMain=$bringMainOnDismiss")
        callIdToEnd?.takeIf { it.isNotEmpty() }?.let { EndedCallIds.add(this, it) }
        clearIncomingTimeout()
        stopCallRingtone()
        stopRepeatingVibration()
        if (closeHandled || isFinishing || isDestroyed) return
        closeHandled = true
        closingForCompletion = true
        isInForeground = false
        LiviOngoingCallHelper.clearOngoingCall(applicationContext)
        if (!acceptInProgress) {
            try {
                LiviAppModule.releaseBackgroundMediaSuppressionStatic(applicationContext)
            } catch (_: Exception) {}
        }
        // Accept: Main надо поднять сразу (Incoming — отдельная задача).
        // Cancel (broadcast/JUST_CLOSE): bringMainOnDismiss=false — только finish без REORDER (иначе мерцание).
        // Timeout при returnMainOnDismiss: мягкий fallback, если Main не стал foreground.
        val wantMain = when {
            acceptInProgress -> true
            bringMainOnDismiss != null -> bringMainOnDismiss
            else -> returnMainOnDismiss
        }
        if (!mainReturnScheduled && wantMain) {
            mainReturnScheduled = true
            if (acceptInProgress) {
                LiviAppModule.scheduleMainActivityAfterOutgoingUserCancel(applicationContext)
            } else {
                LiviAppModule.scheduleMainActivityAfterIncomingCancelDismiss(applicationContext)
            }
        }
        android.util.Log.e(TAG, "IncomingCallActivity closeIncomingScreen: setting isInForeground=false, calling finish()")
        finish()
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
        private const val TAG = "IncomingCallActivity"
        /** Совпадает с [android.media.AudioAttributes.USAGE_RINGTONE] (добавлен в API 29). */
        private const val AUDIO_USAGE_RINGTONE = 6
        private const val INCOMING_TIMEOUT_MS = 27_000L
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_FROM = "from"
        const val EXTRA_FROM_NICK = "fromNick"
        const val EXTRA_HAS_VIDEO = "hasVideo"
        /** FCM call_canceled запускает активность с этим флагом, чтобы закрыть экран без показа UI (приложение в фоне/убито). */
        const val EXTRA_JUST_CLOSE = "just_close"
        /** Закрытие входящего (таймаут/отмена): вернуть MainActivity только если true (пользователь был в приложении). */
        const val EXTRA_RETURN_MAIN_ON_DISMISS = "returnMainOnDismiss"
        const val ACTION_CALL_ANSWERED = "com.kolt12max.livi.CALL_ANSWERED"
        /** true пока нативный экран входящего на экране (защита от heads-up поверх него). */
        @JvmField
        var isInForeground: Boolean = false
        /** true пока экземпляр IncomingCallActivity существует, даже если он ушёл в фон. */
        @JvmField
        var isAlive: Boolean = false
        /** callId текущего живого IncomingCallActivity; нужен FGS, чтобы не делать повторные startActivity для того же звонка. */
        @JvmField
        var activeCallId: String = ""
    }
}
