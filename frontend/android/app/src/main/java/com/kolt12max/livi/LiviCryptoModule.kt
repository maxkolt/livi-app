package com.kolt12max.livi

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Вывод ключа из пароля для резервной копии ключа сквозного шифрования
 * (frontend/sockets/modules/e2eCrypto.ts). PBKDF2 на JS в Hermes (без JIT)
 * занимает десятки секунд и блокирует JS-поток — сокет успевает отвалиться.
 *
 * PBKDF2-HMAC-SHA256 (RFC 8018) над сырыми байтами пароля, а не через PBEKeySpec:
 * тот принимает char[] и сам выбирает кодировку, а результат обязан совпадать
 * байт в байт с iOS (CommonCrypto) и с JS-реализацией.
 */
class LiviCryptoModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private val executor = Executors.newSingleThreadExecutor()

  override fun getName(): String = "LiviCrypto"

  @ReactMethod
  fun pbkdf2Sha256(passwordB64: String, saltB64: String, iterations: Int, keyLength: Int, promise: Promise) {
    if (iterations < 1 || iterations > 10_000_000 || keyLength < 1 || keyLength > 64) {
      promise.reject("E_ARGS", "bad pbkdf2 arguments")
      return
    }
    executor.execute {
      var password: ByteArray? = null
      try {
        password = Base64.decode(passwordB64, Base64.NO_WRAP)
        val salt = Base64.decode(saltB64, Base64.NO_WRAP)
        val key = pbkdf2(password, salt, iterations, keyLength)
        promise.resolve(Base64.encodeToString(key, Base64.NO_WRAP))
        key.fill(0)
      } catch (e: Exception) {
        promise.reject("E_PBKDF2", e.message, e)
      } finally {
        password?.fill(0)
      }
    }
  }

  private fun pbkdf2(password: ByteArray, salt: ByteArray, iterations: Int, keyLength: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    // HMAC допускает пустой ключ, а SecretKeySpec — нет: пустой пароль отсекается раньше, в JS.
    mac.init(SecretKeySpec(password, "HmacSHA256"))
    val hLen = mac.macLength
    val blocks = (keyLength + hLen - 1) / hLen
    val out = ByteArray(blocks * hLen)
    val u = ByteArray(hLen)
    val t = ByteArray(hLen)
    for (block in 1..blocks) {
      mac.update(salt)
      mac.update(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
      mac.doFinal(u, 0)
      System.arraycopy(u, 0, t, 0, hLen)
      for (i in 1 until iterations) {
        mac.update(u)
        mac.doFinal(u, 0)
        for (j in 0 until hLen) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
      }
      System.arraycopy(t, 0, out, (block - 1) * hLen, hLen)
    }
    u.fill(0)
    t.fill(0)
    val key = out.copyOf(keyLength)
    out.fill(0)
    return key
  }
}
