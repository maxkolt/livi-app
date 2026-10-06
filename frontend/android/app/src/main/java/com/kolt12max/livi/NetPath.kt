package com.kolt12max.livi

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Маршрут до API: напрямую или через реле в Финляндии.
 *
 * Через VPN с выходом за рубежом новые соединения к нашим серверам в РФ (REG.RU) открываются
 * 20–70 с, а часть не открывается вовсе: хостинг режет новые подключения с зарубежных адресов,
 * особенно с общих VPN-адресов дата-центров. Google/Cloudflare через тот же VPN — 0.15 с.
 *
 * Реле (RELAY_IP) — простой TCP-переброс 443 → WireGuard → origin:443. TLS сквозной, сертификат
 * api.liviapp.com, поэтому в приложении ничего не меняется: подменяется только адрес, по
 * которому OkHttp открывает соединение к хосту API (dns ниже). Туннель реле↔origin — один
 * постоянный UDP-канал, на него фильтр новых TCP-соединений не действует.
 *
 * Какой путь быстрее, решает гонка двух GET /health: прямой выигрывает сразу, реле — только
 * если прямой не ответил ещё DIRECT_GRACE_MS (без VPN в РФ прямой почти всегда быстрее).
 * Решение запоминается (старт с прошлым маршрутом) и пересматривается при смене сети,
 * старте, пуше звонка и раз в REPROBE_MIN_INTERVAL_MS, пока приложение на экране.
 */
object NetPath {
  private const val TAG = "NetPath"

  /** Реле (livi-turn, Финляндия): TCP 443 → WireGuard → origin:443. */
  private const val RELAY_IP = "185.74.44.244"
  private const val PREFS = "livi_netpath"
  private const val KEY_USE_RELAY = "use_relay"
  /** Сколько ждать прямой путь, если реле ответило первым. */
  private const val DIRECT_GRACE_MS = 300L
  private const val PROBE_TIMEOUT_S = 25L
  private const val REPROBE_MIN_INTERVAL_MS = 60_000L

  @Volatile private var apiHost: String? = null
  @Volatile private var useRelay = false
  @Volatile private var appContext: Context? = null
  @Volatile private var lastProbeAt = 0L
  private val probing = AtomicBoolean(false)
  private val main = Handler(Looper.getMainLooper())

  private val relayAddress: InetAddress by lazy { InetAddress.getByName(RELAY_IP) }

  /** Для всех клиентов приложения: хост API резолвится в реле, если выбран этот путь. */
  val dns: Dns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
      if (useRelay && isApiHost(hostname)) return listOf(relayAddress)
      return Dns.SYSTEM.lookup(hostname)
    }
  }

  private val directDns: Dns = Dns.SYSTEM

  private val relayDns: Dns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> =
      if (isApiHost(hostname)) listOf(relayAddress) else Dns.SYSTEM.lookup(hostname)
  }

  private fun probeClient(dns: Dns): OkHttpClient =
    OkHttpClient.Builder()
      .dns(dns)
      .protocols(listOf(Protocol.HTTP_1_1))
      .connectTimeout(PROBE_TIMEOUT_S, TimeUnit.SECONDS)
      .readTimeout(PROBE_TIMEOUT_S, TimeUnit.SECONDS)
      .callTimeout(PROBE_TIMEOUT_S, TimeUnit.SECONDS)
      .retryOnConnectionFailure(false)
      .build()

  private val directProbe: OkHttpClient by lazy { probeClient(directDns) }
  private val relayProbe: OkHttpClient by lazy { probeClient(relayDns) }

  fun isUsingRelay(): Boolean = useRelay

  private fun isApiHost(hostname: String): Boolean {
    val host = apiHost ?: return false
    return hostname.equals(host, ignoreCase = true)
  }

  /** До первого сетевого клиента (MainApplication.onCreate). */
  fun init(context: Context) {
    val app = context.applicationContext
    appContext = app
    apiHost = LiviAppModule.resolveServerBaseUrl(app)?.toHttpUrlOrNull()?.host
    useRelay = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_USE_RELAY, false)
    Log.i(TAG, "init host=$apiHost useRelay=$useRelay")
  }

  /**
   * Пересмотреть маршрут: гонка прямого пути и реле. [force] — без паузы между проверками
   * (смена сети, сбой запроса).
   */
  fun probe(reason: String, force: Boolean = false) {
    val host = apiHost ?: return
    val now = SystemClock.elapsedRealtime()
    if (!force && lastProbeAt > 0 && now - lastProbeAt < REPROBE_MIN_INTERVAL_MS) return
    if (!probing.compareAndSet(false, true)) return
    lastProbeAt = now
    val url = "https://$host/health"
    val startedAt = now
    val decided = AtomicBoolean(false)
    val pending = AtomicInteger(2)
    // -1 — ещё идёт, -2 — не ответил, иначе мс до ответа.
    val directMs = AtomicLong(-1L)
    val relayMs = AtomicLong(-1L)

    fun done() {
      if (pending.decrementAndGet() > 0) return
      probing.set(false)
      if (!decided.get()) {
        Log.w(TAG, "probe reason=$reason: no path answered (direct=${directMs.get()} relay=${relayMs.get()})")
      }
    }

    fun decide(relay: Boolean, why: String) {
      if (!decided.compareAndSet(false, true)) return
      setRoute(relay, "$reason $why direct=${directMs.get()} relay=${relayMs.get()}")
    }

    enqueue(directProbe, "direct", url) { ok ->
      directMs.set(if (ok) SystemClock.elapsedRealtime() - startedAt else -2L)
      if (ok) decide(false, "direct_first") else if (relayMs.get() >= 0) decide(true, "direct_failed")
      done()
    }
    enqueue(relayProbe, "relay", url) { ok ->
      relayMs.set(if (ok) SystemClock.elapsedRealtime() - startedAt else -2L)
      if (ok) {
        // Прямой путь в РФ без VPN почти всегда быстрее — даём ему немного форы.
        main.postDelayed({ if (directMs.get() < 0) decide(true, "relay_first") }, DIRECT_GRACE_MS)
      }
      done()
    }
  }

  private fun enqueue(client: OkHttpClient, path: String, url: String, onDone: (Boolean) -> Unit) {
    val request = Request.Builder().url(url).header("Cache-Control", "no-cache").build()
    val startedAt = SystemClock.elapsedRealtime()
    client.newCall(request).enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          Log.w(TAG, "probe $path failed ms=${SystemClock.elapsedRealtime() - startedAt} ${e.javaClass.simpleName}: ${e.message}")
          onDone(false)
        }

        override fun onResponse(call: Call, response: Response) {
          val code = response.use { it.code }
          Log.i(TAG, "probe $path code=$code ms=${SystemClock.elapsedRealtime() - startedAt}")
          onDone(code in 200..299)
        }
      },
    )
  }

  private fun setRoute(relay: Boolean, detail: String) {
    val changed = relay != useRelay
    useRelay = relay
    Log.i(TAG, "route=${if (relay) "relay" else "direct"} changed=$changed $detail")
    if (!changed) return
    appContext?.let { ctx ->
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_USE_RELAY, relay).apply()
      // Свободные соединения старого пути больше не нужны; тёплые — уже по новому.
      WarmConnections.onRouteChanged(ctx)
    }
    LiviAppModule.emitNetRouteChanged(if (relay) "relay" else "direct")
  }

  /**
   * Короткий POST JSON с нативных экранов (входящий/исходящий, отклонение): через общий пул
   * тёплых соединений и выбранный маршрут. Вызывать не с главного потока. Возвращает HTTP-код
   * или -1 при сетевой ошибке.
   */
  fun postJsonBlocking(url: String, json: String, headers: Map<String, String>, timeoutMs: Long): Int {
    val builder = Request.Builder()
      .url(url)
      .post(json.toRequestBody("application/json".toMediaType()))
    for ((k, v) in headers) builder.header(k, v)
    val client = WarmConnections.sharedClient().newBuilder()
      .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
      .build()
    return try {
      client.newCall(builder.build()).execute().use { it.code }
    } catch (e: IOException) {
      Log.w(TAG, "post failed url=$url route=${if (useRelay) "relay" else "direct"}: ${e.message}")
      // Сбой запроса — повод перепроверить путь (например, VPN включили на ходу).
      probe("post_failed", force = true)
      -1
    }
  }
}
