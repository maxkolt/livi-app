package com.kolt12max.livi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * «Надёжные звонки» (по желанию пользователя, из профиля).
 *
 * FCM остаётся основным каналом. Но VPN, который душит постоянное соединение Google, задерживает
 * пуши на 10+ с или теряет их, и при закрытом LiVi звонок не доходит. Здесь держим собственный
 * WebSocket к серверу LiVi (бэкенд: utils/callKeepAlive.ts) — тем же маршрутом NetPath, что и всё
 * приложение. События звонка приходят тем же набором полей, что FCM data, и идут в тот же
 * обработчик ([LiviFirebaseMessagingService.handleKeepAlivePush]) — он же отсекает дубли по callId.
 *
 * Цена — постоянное тихое уведомление и чуть больший расход батареи; выключается из уведомления.
 */
class CallKeepAliveService : Service() {

  private lateinit var worker: HandlerThread
  private lateinit var handler: Handler
  private var socket: WebSocket? = null
  /** Поколение соединения: колбэки старого сокета после переподключения игнорируются. */
  private var generation = 0
  private var attempt = 0
  private var lastNetwork: Network? = null
  private var lastNetworkIsVpn: Boolean? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var started = false

  private val reconnectRunnable = Runnable { connect("retry") }
  /** Сервер шлёт heartbeat каждые 40 с; тишина дольше — соединение молча умерло (VPN/NAT). */
  private val watchdogRunnable = Runnable {
    Log.w(TAG, "heartbeat lost — reconnecting")
    reconnectNow("heartbeat_lost")
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    worker = HandlerThread("CallKeepAlive").apply { start() }
    handler = Handler(worker.looper)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_DISABLE) {
      Log.i(TAG, "disabled from notification")
      setEnabledFlag(this, false)
      // startForegroundService() обязывает показать уведомление даже на пути выключения.
      promoteToForeground()
      stopEverything()
      return START_NOT_STICKY
    }
    if (!isEnabled(this)) {
      promoteToForeground()
      stopEverything()
      return START_NOT_STICKY
    }
    promoteToForeground()
    if (!started) {
      started = true
      registerNetworkWatch()
      handler.post { connect(intent?.getStringExtra(EXTRA_REASON) ?: "start") }
    } else {
      // Повторный старт (приложение вышло на передний план, загрузка) — проверить, что живы.
      handler.post { if (socket == null) connect("restart") }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    started = false
    unregisterNetworkWatch()
    handler.removeCallbacksAndMessages(null)
    closeSocket("service_destroyed")
    worker.quitSafely()
    publishStatus(this, STATUS_OFF)
    super.onDestroy()
  }

  private fun stopEverything() {
    publishStatus(this, STATUS_OFF)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun promoteToForeground() {
    ensureChannel(this)
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    } else {
      0
    }
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(this, currentStatus), type)
    } catch (e: Exception) {
      Log.w(TAG, "startForeground failed: ${e.message}")
    }
  }

  // ---------------- соединение ----------------

  private fun connect(reason: String) {
    if (!started) return
    handler.removeCallbacks(reconnectRunnable)
    closeSocket("reconnect:$reason")
    val prefs = applicationContext.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
    val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
    val installSecret = prefs.getString(LiviAppModule.KEY_INSTALL_SECRET, null)?.takeIf { it.isNotBlank() }
    val userId = prefs.getString(LiviAppModule.KEY_USER_ID_FOR_DECLINE, null)?.takeIf { it.isNotBlank() }
    val base = LiviAppModule.resolveServerBaseUrl(applicationContext)
    if (installId == null || base == null) {
      // Ещё не вошли в аккаунт: проверим позже, сервис не держит соединение впустую.
      publishStatus(this, STATUS_NO_ACCOUNT)
      handler.postDelayed(reconnectRunnable, NO_ACCOUNT_RETRY_MS)
      return
    }
    if (!hasUsableNetwork()) {
      publishStatus(this, STATUS_WAITING_NETWORK)
      return
    }
    val url = base.trimEnd('/').replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") + PATH
    val request = Request.Builder()
      .url(url)
      .header("x-install-id", installId)
      .apply {
        if (installSecret != null) header("x-install-secret", installSecret)
        if (userId != null) header("x-user-id", userId)
      }
      .build()
    val myGeneration = ++generation
    val startedAt = SystemClock.elapsedRealtime()
    publishStatus(this, STATUS_CONNECTING)
    Log.i(TAG, "connecting reason=$reason attempt=$attempt relay=${NetPath.isUsingRelay()}")
    socket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        handler.post {
          if (myGeneration != generation) return@post
          attempt = 0
          lastConnectedAt = System.currentTimeMillis()
          Log.i(TAG, "connected ms=${SystemClock.elapsedRealtime() - startedAt} reason=$reason")
          publishStatus(this@CallKeepAliveService, STATUS_CONNECTED)
          armWatchdog()
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handler.post {
          if (myGeneration != generation) return@post
          armWatchdog()
          handleFrame(text)
        }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        handler.post { onDisconnected(myGeneration, "closed:$code") }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        val code = response?.code ?: 0
        handler.post {
          if (code == 401) {
            // Установка не привязана к аккаунту (вышли / удалили профиль) — не долбим сервер.
            if (myGeneration != generation) return@post
            socket = null
            handler.removeCallbacks(watchdogRunnable)
            publishStatus(this@CallKeepAliveService, STATUS_NO_ACCOUNT)
            handler.postDelayed(reconnectRunnable, NO_ACCOUNT_RETRY_MS)
            return@post
          }
          onDisconnected(myGeneration, "failure:${t.javaClass.simpleName}:${t.message}")
        }
      }
    })
  }

  private fun onDisconnected(myGeneration: Int, why: String) {
    if (myGeneration != generation) return
    socket = null
    handler.removeCallbacks(watchdogRunnable)
    if (!started) return
    if (!hasUsableNetwork()) {
      Log.i(TAG, "disconnected ($why), waiting for network")
      publishStatus(this, STATUS_WAITING_NETWORK)
      return
    }
    val delay = BACKOFF_MS[attempt.coerceAtMost(BACKOFF_MS.size - 1)]
    attempt += 1
    Log.i(TAG, "disconnected ($why), retry in ${delay}ms")
    publishStatus(this, STATUS_CONNECTING)
    handler.postDelayed(reconnectRunnable, delay)
  }

  private fun reconnectNow(reason: String) {
    handler.post {
      attempt = 0
      connect(reason)
    }
  }

  private fun closeSocket(reason: String) {
    val current = socket ?: return
    socket = null
    generation += 1
    handler.removeCallbacks(watchdogRunnable)
    runCatching { current.cancel() }
    Log.d(TAG, "socket closed: $reason")
  }

  private fun armWatchdog() {
    handler.removeCallbacks(watchdogRunnable)
    handler.postDelayed(watchdogRunnable, HEARTBEAT_TIMEOUT_MS)
  }

  private fun handleFrame(text: String) {
    val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
    if (frame.optString("t") != "push") return
    val json = frame.optJSONObject("data") ?: return
    val data = HashMap<String, String>()
    for (key in json.keys()) data[key] = json.optString(key)
    val sentAt = frame.optLong("sentAt", 0L)
    Log.i(
      TAG,
      "push type=${data["type"]} callId=${data["callId"]} " +
        "lagMs=${if (sentAt > 0) System.currentTimeMillis() - sentAt else -1}",
    )
    try {
      LiviFirebaseMessagingService.handleKeepAlivePush(applicationContext, data)
    } catch (e: Exception) {
      Log.w(TAG, "push handling failed", e)
    }
  }

  // ---------------- сеть ----------------

  private fun hasUsableNetwork(): Boolean {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return true
    val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
  }

  /**
   * Смена сети по умолчанию — Wi-Fi ↔ мобильная, включили/выключили VPN: старое соединение
   * мертво (или идёт мимо нового VPN). Переподключаемся сразу, без ожидания сторожа.
   */
  private fun registerNetworkWatch() {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        handler.post {
          val previous = lastNetwork
          lastNetwork = network
          when {
            // Первый колбэк сразу после регистрации — текущая сеть, подключение уже идёт.
            previous == null -> if (currentStatus == STATUS_WAITING_NETWORK) reconnectNow("network_back")
            previous != network -> reconnectNow("network_change")
          }
        }
      }

      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        val isVpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        handler.post {
          val previous = lastNetworkIsVpn
          lastNetworkIsVpn = isVpn
          if (previous != null && previous != isVpn && network == lastNetwork) reconnectNow("vpn_change")
        }
      }

      override fun onLost(network: Network) {
        handler.post {
          if (network != lastNetwork) return@post
          lastNetwork = null
          if (!hasUsableNetwork()) {
            closeSocket("network_lost")
            handler.removeCallbacks(reconnectRunnable)
            publishStatus(this@CallKeepAliveService, STATUS_WAITING_NETWORK)
          }
        }
      }
    }
    try {
      // Без Handler (API 24): колбэки и так перекладываются в handler.
      cm.registerDefaultNetworkCallback(callback)
      networkCallback = callback
    } catch (e: RuntimeException) {
      Log.w(TAG, "network callback failed: ${e.message}")
    }
  }

  private fun unregisterNetworkWatch() {
    val cb = networkCallback ?: return
    networkCallback = null
    runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
  }

  companion object {
    private const val TAG = "CallKeepAlive"
    const val PATH = "/keepalive/calls"
    const val CHANNEL_ID = "livi_call_keepalive_v1"
    const val NOTIFICATION_ID = 1301
    const val ACTION_START = "com.kolt12max.livi.CALL_KEEPALIVE_START"
    const val ACTION_DISABLE = "com.kolt12max.livi.CALL_KEEPALIVE_DISABLE"
    private const val EXTRA_REASON = "reason"
    private const val PREF_ENABLED = "call_keepalive_enabled"
    /** 2.5 × heartbeat сервера (40 с): один потерянный кадр — ещё не повод рвать соединение. */
    private const val HEARTBEAT_TIMEOUT_MS = 100_000L
    private const val NO_ACCOUNT_RETRY_MS = 5 * 60_000L
    private val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000)

    const val STATUS_OFF = "off"
    const val STATUS_CONNECTING = "connecting"
    const val STATUS_CONNECTED = "connected"
    const val STATUS_WAITING_NETWORK = "waiting_network"
    const val STATUS_NO_ACCOUNT = "no_account"

    @Volatile var currentStatus: String = STATUS_OFF
      private set
    @Volatile var lastConnectedAt: Long = 0L
      private set
    /** Модуль JS подписывается, чтобы экран «Надёжные звонки» показывал живое состояние. */
    @Volatile var statusListener: ((String) -> Unit)? = null

    /** WebSocket: свой клиент без таймаута чтения, но с маршрутом NetPath и TLS общего клиента. */
    private val client: OkHttpClient by lazy {
      WarmConnections.sharedClient().newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        // Только рукопожатие: после upgrade OkHttp снимает callTimeout (timeoutEarlyExit).
        // Без него сервер, не ответивший на upgrade, держал бы «Подключение…» бесконечно.
        .callTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(0, TimeUnit.SECONDS)
        .build()
    }

    private fun prefs(context: Context) =
      context.applicationContext.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)

    @JvmStatic
    fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(PREF_ENABLED, false)

    private fun setEnabledFlag(context: Context, enabled: Boolean) {
      prefs(context).edit().putBoolean(PREF_ENABLED, enabled).apply()
    }

    /** Включить/выключить режим. false — если система не дала запустить сервис. */
    @JvmStatic
    fun setEnabled(context: Context, enabled: Boolean): Boolean {
      setEnabledFlag(context, enabled)
      return if (enabled) {
        start(context, "user_enabled")
      } else {
        context.applicationContext.stopService(Intent(context.applicationContext, CallKeepAliveService::class.java))
        publishStatus(context, STATUS_OFF)
        true
      }
    }

    /** Запуск при старте процесса, выходе на передний план, после загрузки/обновления. */
    @JvmStatic
    fun startIfEnabled(context: Context, reason: String): Boolean {
      if (!isEnabled(context)) return false
      return start(context, reason)
    }

    private fun start(context: Context, reason: String): Boolean {
      val app = context.applicationContext
      return try {
        ContextCompat.startForegroundService(
          app,
          Intent(app, CallKeepAliveService::class.java).setAction(ACTION_START).putExtra(EXTRA_REASON, reason),
        )
        true
      } catch (e: Exception) {
        // Android 12+: старт FGS из фона запрещён вне исключений — запустимся при выходе на передний план.
        Log.w(TAG, "start not allowed now reason=$reason: ${e.javaClass.simpleName}")
        false
      }
    }

    private fun publishStatus(context: Context, status: String) {
      val changed = currentStatus != status
      currentStatus = status
      if (!changed) return
      if (status != STATUS_OFF) {
        runCatching {
          val nm = context.getSystemService(NotificationManager::class.java)
          nm?.notify(NOTIFICATION_ID, buildNotification(context, status))
        }
      }
      runCatching { statusListener?.invoke(status) }
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      val name = AppLocale.str(context, R.string.call_keepalive_channel)
      val existing = nm.getNotificationChannel(CHANNEL_ID)
      if (existing != null) {
        if (existing.name != name) existing.name = name
        nm.createNotificationChannel(existing)
        return
      }
      val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW).apply {
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
        lockscreenVisibility = Notification.VISIBILITY_SECRET
      }
      nm.createNotificationChannel(channel)
    }

    private fun buildNotification(context: Context, status: String): Notification {
      val text = AppLocale.str(
        context,
        when (status) {
          STATUS_CONNECTED -> R.string.call_keepalive_text_connected
          STATUS_WAITING_NETWORK -> R.string.call_keepalive_text_waiting
          else -> R.string.call_keepalive_text_connecting
        },
      )
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, NOTIFICATION_ID, it, flags)
      }
      val disableIntent = Intent(context, CallKeepAliveService::class.java).setAction(ACTION_DISABLE)
      val disable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        PendingIntent.getForegroundService(context, NOTIFICATION_ID + 1, disableIntent, flags)
      } else {
        PendingIntent.getService(context, NOTIFICATION_ID + 1, disableIntent, flags)
      }
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_menu_call)
        .setContentTitle(AppLocale.str(context, R.string.call_keepalive_title))
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .apply { if (open != null) setContentIntent(open) }
        .addAction(0, AppLocale.str(context, R.string.call_keepalive_action_disable), disable)
        .build()
    }
  }
}
