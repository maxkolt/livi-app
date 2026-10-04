package com.kolt12max.livi

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import android.util.Log
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.websocket.WebSocketModule
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.EventListener
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Тёплые TLS-соединения к API для WebSocket'ов: LiveKit signal proxy и socket.io.
 *
 * Через VPN с выходом за рубежом новое соединение к нашим серверам в РФ иногда открывается
 * 15–30 с: первые пакеты теряются, и TCP повторяет их через 1, 2, 4, 8 (и 16) с. Уже
 * открытое соединение при этом работает быстро. RN создаёт каждому WebSocket'у новый
 * OkHttpClient со своим пулом, поэтому любое подключение — это новое рукопожатие, и звонок
 * упирался в сторож сигналинга (8 с).
 *
 * Здесь у WebSocket'ов общий пул и TLS-фабрика с «прогревочным» клиентом. Он заранее
 * открывает HTTP/1.1-соединения к API (GET /health), и они ждут в пуле. Upgrade WebSocket'а
 * уходит по уже открытому соединению, без нового рукопожатия: ~0.2 с вместо 1–3 с, а
 * иногда и 17 с. Пул делится, только если у клиентов совпадает Address: тот же пул, та же
 * TLS-фабрика и trust manager, только HTTP/1.1 (RealWebSocket всегда HTTP/1.1).
 *
 * Простаивающее соединение за VPN через несколько минут молча умирает, а WebSocket на нём
 * падает только через ~9 с. Поэтому в пуле живут лишь свежие соединения: простой не
 * дольше KEEP_ALIVE_S, а пока приложение на экране, JS каждые 30 с вызывает warm() —
 * запросы проходят по свободным соединениям, освежают и заодно проверяют их.
 */
object WarmConnections {
  private const val TAG = "WarmConnections"

  /** Столько свободных соединений к API держим наготове. */
  private const val DEFAULT_IDLE = 2
  /** Больше одновременных прогревов не нужно: каждое зависшее соединение и так дождётся своего. */
  private const val MAX_IN_FLIGHT = 4
  /** Дольше простоявшее соединение выбрасываем: за VPN оно может быть уже мёртвым. */
  private const val KEEP_ALIVE_S = 50L

  private val pool = ConnectionPool(8, KEEP_ALIVE_S, TimeUnit.SECONDS)
  private val trustManager: X509TrustManager = defaultTrustManager()
  private val sslSocketFactory: SSLSocketFactory =
    SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trustManager), null) }.socketFactory

  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectionPool(pool)
      .sslSocketFactory(sslSocketFactory, trustManager)
      .protocols(listOf(Protocol.HTTP_1_1))
      // Зависшее соединение всё равно нужно: досидит повторы TCP и ляжет в пул.
      .connectTimeout(45, TimeUnit.SECONDS)
      .readTimeout(45, TimeUnit.SECONDS)
      .build()
  }

  private val inFlight = AtomicInteger(0)
  @Volatile private var installed = false
  @Volatile private var defaultNetwork: Network? = null

  /**
   * Подключения сигналинга LiveKit (`…/rtc`), которые ещё не отправили upgrade-запрос
   * (значение — время старта). Через VPN TLS-рукопожатие иногда висит 15–30 с: сторож
   * сигналинга (8 с) бросает попытку и начинает новую, а зависшая потом всё же доходит до
   * SFU с тем же identity и выбивает уже рабочую (DUPLICATE_IDENTITY) — и так по кругу,
   * пока звонок не оборвётся. Отменённое до отправки запроса подключение до сервера не доходит.
   */
  private val pendingSignalCalls = ConcurrentHashMap<Call, Long>()

  private val signalCallTracker = object : EventListener() {
    override fun callStart(call: Call) {
      val path = call.request().url.encodedPath
      if (path.endsWith("/rtc") || path.contains("/rtc/")) {
        pendingSignalCalls[call] = SystemClock.elapsedRealtime()
      }
    }

    override fun requestHeadersStart(call: Call) {
      pendingSignalCalls.remove(call)
    }

    override fun callFailed(call: Call, ioe: IOException) {
      pendingSignalCalls.remove(call)
    }

    override fun callEnd(call: Call) {
      pendingSignalCalls.remove(call)
    }
  }

  /** Подключить общий пул к WebSocket'ам RN. Вызывать до первого WebSocket'а. */
  fun install() {
    if (installed) return
    installed = true
    WebSocketModule.setCustomClientBuilder(
      CustomClientBuilder { builder ->
        builder
          .connectionPool(pool)
          .sslSocketFactory(sslSocketFactory, trustManager)
          .eventListenerFactory { signalCallTracker }
      },
    )
  }

  /**
   * Отменить зависшие сигнальные подключения LiveKit, ещё не дошедшие до сервера.
   * Только старше [minAgeMs]: новая попытка, начатая сразу после сторожа, не трогается.
   */
  fun cancelPendingLiveKitSignal(reason: String, minAgeMs: Long = 2_000L): Int {
    val now = SystemClock.elapsedRealtime()
    var canceled = 0
    for ((call, startedAt) in pendingSignalCalls) {
      if (now - startedAt < minAgeMs) continue
      pendingSignalCalls.remove(call)
      runCatching { call.cancel() }
      canceled += 1
    }
    Log.i(TAG, "cancel pending livekit signal reason=$reason canceled=$canceled left=${pendingSignalCalls.size}")
    return canceled
  }

  /**
   * Новая сеть по умолчанию (включили или выключили VPN, Wi-Fi ↔ мобильная): соединения
   * старой сети мертвы — выбрасываем и открываем новые.
   */
  fun watchNetwork(context: Context) {
    val app = context.applicationContext
    val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
    try {
      cm.registerDefaultNetworkCallback(
        object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) {
            val previous = defaultNetwork
            defaultNetwork = network
            if (previous == null || previous == network) return
            pool.evictAll()
            warm(app, "network_change")
          }
        },
      )
    } catch (e: RuntimeException) {
      Log.w(TAG, "network callback failed: ${e.message}")
    }
  }

  /**
   * Пустить count одновременных запросов к API: каждый берёт своё свободное соединение
   * (освежает его) или открывает новое. После этого свободных — не меньше count.
   */
  fun warm(context: Context, reason: String, count: Int = DEFAULT_IDLE) {
    if (!installed) return
    val base = LiviAppModule.resolveServerBaseUrl(context.applicationContext) ?: return
    val url = "${base.trimEnd('/')}/health".toHttpUrlOrNull() ?: return
    if (!url.isHttps) return
    val need = count.coerceIn(1, MAX_IN_FLIGHT) - inFlight.get()
    repeat(need.coerceAtLeast(0)) { open(url.toString(), reason) }
  }

  private fun open(url: String, reason: String) {
    inFlight.incrementAndGet()
    val startedAt = SystemClock.elapsedRealtime()
    val request = Request.Builder().url(url).header("Cache-Control", "no-cache").build()
    client.newCall(request).enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          inFlight.decrementAndGet()
          Log.w(TAG, "warm failed reason=$reason ms=${SystemClock.elapsedRealtime() - startedAt} ${e.message}")
        }

        override fun onResponse(call: Call, response: Response) {
          // Тело дочитываем до конца — только тогда соединение возвращается в пул.
          response.use { runCatching { it.body?.bytes() } }
          inFlight.decrementAndGet()
          Log.i(
            TAG,
            "warm ok reason=$reason code=${response.code} ms=${SystemClock.elapsedRealtime() - startedAt} " +
              "idle=${pool.idleConnectionCount()} total=${pool.connectionCount()}",
          )
        }
      },
    )
  }

  private fun defaultTrustManager(): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
  }
}
