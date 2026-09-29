package com.kolt12max.livi

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

/**
 * Ключ сквозного шифрования чата в Google Block Store.
 *
 * SecureStore на Android стирается при удалении приложения, а аккаунт LiVi переживает
 * переустановку. Block Store сохраняется между удалением и установкой на том же
 * устройстве (если включено «Резервное копирование Google»), поэтому переписка
 * остаётся читаемой без пароля. В облако Google копия уходит только при доступном
 * сквозном шифровании Block Store (Android 9+ и блокировка экрана) — тогда её
 * не может прочитать и Google; иначе ключ живёт только на устройстве.
 *
 * save/remove мягкие: сбой — false. load при временном сбое отклоняется (см. ниже).
 */
class LiviKeyVaultModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "LiviKeyVault"

  private fun client() = Blockstore.getClient(reactApplicationContext)

  @ReactMethod
  fun save(key: String, valueB64: String, promise: Promise) {
    val bytes = try {
      Base64.decode(valueB64, Base64.NO_WRAP)
    } catch (e: Exception) {
      promise.resolve(false)
      return
    }
    try {
      val c = client()
      c.isEndToEndEncryptionAvailable
        .continueWithTask { task ->
          val cloud = task.isSuccessful && task.result == true
          c.storeBytes(
            StoreBytesData.Builder()
              .setKey(key)
              .setBytes(bytes)
              .setShouldBackupToCloud(cloud)
              .build(),
          )
        }
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { promise.resolve(false) }
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * null — ключа нет (или на устройстве нет Google Play services, хранилища нет вовсе).
   * Временный сбой — reject: JS не должен принять его за «ключа нет» и создать новый,
   * иначе старая переписка станет нечитаемой.
   */
  @ReactMethod
  fun load(key: String, promise: Promise) {
    if (!hasPlayServices()) {
      promise.resolve(null)
      return
    }
    try {
      client()
        .retrieveBytes(RetrieveBytesRequest.Builder().setKeys(listOf(key)).build())
        .addOnSuccessListener { response ->
          val bytes = response.blockstoreDataMap[key]?.bytes
          promise.resolve(if (bytes != null && bytes.isNotEmpty()) Base64.encodeToString(bytes, Base64.NO_WRAP) else null)
        }
        .addOnFailureListener { e -> promise.reject("E_VAULT", e.message, e) }
    } catch (e: Exception) {
      promise.reject("E_VAULT", e.message, e)
    }
  }

  private fun hasPlayServices(): Boolean =
    try {
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(reactApplicationContext) ==
        ConnectionResult.SUCCESS
    } catch (e: Exception) {
      false
    }

  @ReactMethod
  fun remove(key: String, promise: Promise) {
    try {
      client()
        .deleteBytes(DeleteBytesRequest.Builder().setKeys(listOf(key)).build())
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { promise.resolve(false) }
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }
}
