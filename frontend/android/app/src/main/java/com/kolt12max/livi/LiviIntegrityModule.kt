package com.kolt12max.livi

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest

/**
 * Play Integrity, стандартные запросы: токен, привязанный к requestHash (installId + секрет установки).
 * Сервер расшифровывает его у Google и пока только записывает вердикт (backend/routes/integrity.ts).
 */
class LiviIntegrityModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "LiviIntegrity"

  /** Подготовленный провайдер живёт долго; при его протухании Google вернёт ошибку — тогда готовим заново. */
  private var provider: StandardIntegrityTokenProvider? = null
  private var providerProject = 0L

  @ReactMethod
  fun requestToken(cloudProjectNumber: Double, requestHash: String, promise: Promise) {
    val project = cloudProjectNumber.toLong()
    val cached = provider
    if (cached != null && providerProject == project) {
      request(cached, requestHash, promise)
      return
    }
    try {
      IntegrityManagerFactory.createStandard(reactApplicationContext)
        .prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(project).build())
        .addOnSuccessListener { prepared ->
          provider = prepared
          providerProject = project
          request(prepared, requestHash, promise)
        }
        .addOnFailureListener { e -> reject(promise, e) }
    } catch (e: Exception) {
      reject(promise, e)
    }
  }

  private fun request(prepared: StandardIntegrityTokenProvider, requestHash: String, promise: Promise) {
    prepared
      .request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
      .addOnSuccessListener { response -> promise.resolve(response.token()) }
      .addOnFailureListener { e ->
        provider = null
        reject(promise, e)
      }
  }

  private fun reject(promise: Promise, e: Exception) {
    val code = (e as? StandardIntegrityException)?.errorCode
    promise.reject(if (code != null) "E_INTEGRITY_$code" else "E_INTEGRITY", e.message, e)
  }
}
