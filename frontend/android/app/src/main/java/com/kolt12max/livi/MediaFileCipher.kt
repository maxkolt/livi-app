package com.kolt12max.livi

import java.io.File
import java.io.InputStream
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Versioned AES-256-GCM files. A failed tag never publishes a plaintext file. */
object MediaFileCipher {
  private val magic = byteArrayOf(0x4c, 0x56, 0x4d, 0x31)
  private val aad = "livi-media-v1".toByteArray(Charsets.US_ASCII)
  private const val MAX_BYTES = 100L * 1024 * 1024

  fun encrypt(input: InputStream, target: File, key: ByteArray) = transform(input, target, key, true)
  fun decrypt(input: InputStream, target: File, key: ByteArray) = transform(input, target, key, false)

  private fun readExact(input: InputStream, size: Int): ByteArray {
    val bytes = ByteArray(size)
    var offset = 0
    while (offset < size) {
      val n = input.read(bytes, offset, size - offset)
      require(n > 0) { "truncated_media" }
      offset += n
    }
    return bytes
  }

  private fun transform(input: InputStream, target: File, key: ByteArray, encrypt: Boolean) {
    require(key.size == 32)
    require(!target.exists()) { "destination_exists" }
    val partial = File.createTempFile("livi-media-", ".part", target.parentFile)
    try {
      input.use { source ->
        val nonce = if (encrypt) ByteArray(12).also { SecureRandom().nextBytes(it) } else {
          require(readExact(source, magic.size).contentEquals(magic)) { "invalid_media_format" }
          readExact(source, 12)
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        partial.outputStream().use { output ->
          if (encrypt) { output.write(magic); output.write(nonce) }
          // Explicit doFinal propagates bad tags on every provider; never rely on
          // CipherInputStream/CipherOutputStream swallowing authentication errors.
          var count = 0L
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val n = source.read(buffer)
            if (n < 0) break
            count += n
            require(count <= MAX_BYTES + if (encrypt) 0 else 16) { "media_too_large" }
            cipher.update(buffer, 0, n)?.let { output.write(it) }
          }
          output.write(cipher.doFinal())
        }
      }
      check(partial.renameTo(target)) { "media_commit_failed" }
    } finally { partial.delete() }
  }
}
