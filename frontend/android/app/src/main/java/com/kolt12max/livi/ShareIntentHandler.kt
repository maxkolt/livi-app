package com.kolt12max.livi

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

/**
 * Обработка системного «Поделиться» (ACTION_SEND / SEND_MULTIPLE).
 * Видео не принимаем; файлы копируются в cache/incoming_share с grant URI.
 */
object ShareIntentHandler {
  private const val TAG = "ShareIntentHandler"
  private const val CACHE_SUBDIR = "incoming_share"

  fun isShareIntent(intent: Intent?): Boolean {
    if (intent == null) return false
    val action = intent.action ?: return false
    return action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE
  }

  /** Сохранить в LiviAppModule; вернуть true, если есть хотя бы один поддерживаемый элемент. */
  fun stashFromIntent(context: Context, intent: Intent): Boolean {
    val items = buildShareItems(context, intent)
    if (items.isEmpty()) {
      Log.i(TAG, "share intent ignored: no supported items")
      return false
    }
    LiviAppModule.setPendingShareItems(itemsToWritableArray(items))
    clearShareIntentExtras(intent)
    Log.i(TAG, "stashed share items count=${items.size}")
    return true
  }

  private fun clearShareIntentExtras(intent: Intent) {
    try {
      intent.action = Intent.ACTION_MAIN
      intent.removeExtra(Intent.EXTRA_TEXT)
      intent.removeExtra(Intent.EXTRA_SUBJECT)
      intent.removeExtra(Intent.EXTRA_STREAM)
      intent.clipData = null
      intent.data = null
      intent.type = null
    } catch (e: Exception) {
      Log.w(TAG, "clearShareIntentExtras failed", e)
    }
  }

  private data class ShareItem(
    val kind: String,
    val uri: String?,
    val text: String?,
    val mimeType: String?,
    val name: String?,
    val size: Long,
  )

  private fun buildShareItems(context: Context, intent: Intent): List<ShareItem> {
    val action = intent.action ?: return emptyList()
    val out = mutableListOf<ShareItem>()
    when (action) {
      Intent.ACTION_SEND -> {
        val type = intent.type?.lowercase(Locale.US)
        val stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (stream != null) {
          itemFromStream(context, stream, type)?.let { out.add(it) }
        } else if (text.isNotEmpty()) {
          out.add(ShareItem(kind = "text", uri = null, text = text, mimeType = type, name = null, size = 0))
        }
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        val streams = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        val type = intent.type?.lowercase(Locale.US)
        if (!streams.isNullOrEmpty()) {
          for (uri in streams) {
            itemFromStream(context, uri, type)?.let { out.add(it) }
          }
        }
      }
    }
    return out
  }

  private fun itemFromStream(context: Context, uri: Uri, hintType: String?): ShareItem? {
    val mime = resolveMime(context, uri, hintType)
    if (mime.startsWith("video/")) {
      Log.i(TAG, "skip video mime=$mime uri=$uri")
      return null
    }
    val meta = queryDisplayNameAndSize(context, uri)
    val displayName = meta.first
    val size = meta.second
    return when {
      mime.startsWith("image/") -> {
        val local = copyToCache(context, uri, displayName, "img")
        ShareItem("image", local, null, mime, File(local).name, size)
      }
      mime.startsWith("audio/") -> {
        val local = copyToCache(context, uri, displayName, "aud")
        ShareItem("audio", local, null, mime, File(local).name, size)
      }
      mime == "text/plain" -> {
        val text = readTextFromUri(context, uri)
        if (text.isNullOrBlank()) null
        else ShareItem("text", null, text, mime, displayName, size)
      }
      else -> {
        val local = copyToCache(context, uri, displayName, "doc")
        ShareItem("document", local, null, mime, File(local).name, size)
      }
    }
  }

  private fun resolveMime(context: Context, uri: Uri, hintType: String?): String {
    val fromResolver = context.contentResolver.getType(uri)?.lowercase(Locale.US)
    if (!fromResolver.isNullOrBlank()) return fromResolver
    if (!hintType.isNullOrBlank()) return hintType.lowercase(Locale.US)
    val ext = MimeTypeMap.getFileExtensionFromUrl(uri.toString())
    val guessed = if (!ext.isNullOrBlank()) MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase(Locale.US)) else null
    return guessed?.lowercase(Locale.US) ?: "application/octet-stream"
  }

  private fun queryDisplayNameAndSize(context: Context, uri: Uri): Pair<String?, Long> {
    var name: String? = null
    var size = 0L
    try {
      context.contentResolver.query(uri, null, null, null, null)?.use { c ->
        val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
        if (c.moveToFirst()) {
          if (nameIdx >= 0) name = c.getString(nameIdx)
          if (sizeIdx >= 0) size = c.getLong(sizeIdx)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "queryDisplayName failed uri=$uri", e)
    }
    return name to size
  }

  private fun readTextFromUri(context: Context, uri: Uri): String? {
    return try {
      context.contentResolver.openInputStream(uri)?.use { it.bufferedReader().readText() }?.trim()
    } catch (e: Exception) {
      Log.w(TAG, "readTextFromUri failed", e)
      null
    }
  }

  private fun sanitizeFileName(raw: String): String {
    val base = raw.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120).ifBlank { "file" }
    return base
  }

  private fun copyToCache(context: Context, uri: Uri, displayName: String?, prefix: String): String {
    val dir = File(context.cacheDir, CACHE_SUBDIR).apply { mkdirs() }
    val ext = displayName?.substringAfterLast('.', "")?.takeIf { it.isNotBlank() && it.length <= 8 }
    val safeName = sanitizeFileName(displayName ?: "${prefix}_${System.currentTimeMillis()}")
    val fileName = if (safeName.contains('.')) safeName else {
      if (ext != null) "$safeName.$ext" else safeName
    }
    val outFile = File(dir, "${System.currentTimeMillis()}_$fileName")
    context.contentResolver.openInputStream(uri)?.use { input ->
      FileOutputStream(outFile).use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("Cannot open stream for $uri")
    return Uri.fromFile(outFile).toString()
  }

  private fun itemsToWritableArray(items: List<ShareItem>): WritableArray {
    val arr = Arguments.createArray()
    for (it in items) {
      val m: WritableMap = Arguments.createMap()
      m.putString("kind", it.kind)
      if (it.uri != null) m.putString("uri", it.uri)
      if (it.text != null) m.putString("text", it.text)
      if (it.mimeType != null) m.putString("mimeType", it.mimeType)
      if (it.name != null) m.putString("name", it.name)
      if (it.size > 0) m.putDouble("size", it.size.toDouble())
      arr.pushMap(m)
    }
    return arr
  }
}
