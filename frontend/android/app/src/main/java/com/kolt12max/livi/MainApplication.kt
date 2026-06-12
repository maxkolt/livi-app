package com.kolt12max.livi

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.Build

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  /**
   * Базовый масштаб UI: фиксируем fontScale и (API 24+) densityDpi = DENSITY_DEVICE_STABLE —
   * игнор «Размер шрифта» и «Масштаб экрана» в настройках Android.
   */
  override fun attachBaseContext(base: Context) {
    super.attachBaseContext(FontScaleContextHelper.wrap(base))
  }

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
        this,
        object : DefaultReactNativeHost(this) {
          override fun getPackages(): List<ReactPackage> {
            val packages = PackageList(this).packages.toMutableList()
            packages.add(LiviAppPackage())
            return packages
          }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
          override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  private val pipActionReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.action) {
        LiviAppModule.ACTION_END_CALL_FROM_PIP -> LiviAppModule.emitEndCallFromPiP()
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    // Регистрируем каналы уведомлений при старте приложения — пакет попадает в системный кэш истории уведомлений (уменьшает NotifHistoryProto "package name not found in string cache").
    LiviFirebaseMessagingService.ensureCallChannel(this)
    LiviFirebaseMessagingService.ensureMissedCallChannel(this)
    val pipFilter = IntentFilter().apply {
      addAction(LiviAppModule.ACTION_END_CALL_FROM_PIP)
    }
    if (Build.VERSION.SDK_INT >= 33) {
      registerReceiver(pipActionReceiver, pipFilter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(pipActionReceiver, pipFilter)
    }
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    val patched = FontScaleContextHelper.copyPatched(newConfig)
    super.onConfigurationChanged(patched)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, patched)
  }
}
