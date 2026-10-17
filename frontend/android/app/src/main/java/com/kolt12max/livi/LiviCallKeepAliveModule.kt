package com.kolt12max.livi

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

/** JS-мост режима «Надёжные звонки» (экран профиля). Состояние — событие [EVENT]. */
class LiviCallKeepAliveModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    CallKeepAliveService.statusListener = { emitState() }
  }

  override fun invalidate() {
    CallKeepAliveService.statusListener = null
    super.invalidate()
  }

  @ReactMethod
  fun setEnabled(enabled: Boolean, promise: Promise) {
    val started = CallKeepAliveService.setEnabled(reactContext, enabled)
    promise.resolve(stateMap().apply { putBoolean("startAllowed", started) })
  }

  @ReactMethod
  fun getState(promise: Promise) {
    promise.resolve(stateMap())
  }

  /** Приложение вышло на передний план: сервис мог быть убит или не запуститься из фона. */
  @ReactMethod
  fun ensureRunning() {
    CallKeepAliveService.startIfEnabled(reactContext, "app_foreground")
  }

  // NativeEventEmitter на JS требует эти методы, даже если подписка идёт через DeviceEventEmitter.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  private fun emitState() {
    if (!reactContext.hasActiveReactInstance()) return
    runCatching { reactContext.emitDeviceEvent(EVENT, stateMap()) }
  }

  private fun stateMap(): WritableMap = Arguments.createMap().apply {
    val enabled = CallKeepAliveService.isEnabled(reactContext)
    putBoolean("enabled", enabled)
    putString("status", if (enabled) CallKeepAliveService.currentStatus else CallKeepAliveService.STATUS_OFF)
    putDouble("lastConnectedAt", CallKeepAliveService.lastConnectedAt.toDouble())
    putBoolean("vpnActive", isVpnActive())
    putBoolean("notificationsEnabled", NotificationManagerCompat.from(reactContext).areNotificationsEnabled())
  }

  private fun isVpnActive(): Boolean {
    val cm = reactContext.getSystemService(ConnectivityManager::class.java) ?: return false
    val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
    return caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
  }

  companion object {
    const val NAME = "LiviCallKeepAlive"
    const val EVENT = "LiviCallKeepAliveState"
  }
}
