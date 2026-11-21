package com.kolt12max.livi

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

class MediaFileCipherTest {
  @Test fun roundTripAndDifferentNonces() {
    val dir = Files.createTempDirectory("media-cipher-test").toFile()
    try {
      val key = ByteArray(32) { it.toByte() }
      val input = ByteArray(2 * 1024 * 1024) { (it % 251).toByte() }
      val a = File(dir, "a.livi"); val b = File(dir, "b.livi"); val output = File(dir, "plain.mp4")
      MediaFileCipher.encrypt(ByteArrayInputStream(input), a, key)
      MediaFileCipher.encrypt(ByteArrayInputStream(input), b, key)
      assertFalse(a.readBytes().contentEquals(b.readBytes()))
      assertEquals(input.size.toLong() + 32, a.length())
      MediaFileCipher.decrypt(a.inputStream(), output, key)
      assertArrayEquals(input, output.readBytes())
    } finally { dir.deleteRecursively() }
  }
  @Test fun rejectsTamperingWrongKeysAndTruncationWithoutPlaintext() {
    val dir = Files.createTempDirectory("media-cipher-test").toFile()
    try {
      val key = ByteArray(32) { it.toByte() }; val encrypted = File(dir, "encrypted.livi")
      MediaFileCipher.encrypt(ByteArrayInputStream("private attachment".toByteArray()), encrypted, key)
      val original = encrypted.readBytes()
      for (case in 0..3) {
        val changed = original.copyOf()
        if (case == 0) changed[changed.lastIndex] = (changed.last().toInt() xor 1).toByte()
        if (case == 1) changed[6] = (changed[6].toInt() xor 1).toByte()
        val output = File(dir, "failed-$case.jpg")
        val source = if (case == 2) changed.copyOf(10) else changed
        var failed = false
        try { MediaFileCipher.decrypt(ByteArrayInputStream(source), output, if (case == 3) ByteArray(32) else key) }
        catch (_: Exception) { failed = true }
        assertTrue(failed); assertFalse(output.exists())
        assertTrue(dir.listFiles()!!.none { it.extension == "part" })
      }
    } finally { dir.deleteRecursively() }
  }
}
