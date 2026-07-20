package com.kolt12max.livi

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.Locale

/**
 * Save an image into the device gallery via MediaStore.
 * On Android 10+ this does not require READ_MEDIA_* / WRITE_EXTERNAL_STORAGE
 * (Play policy: use Photo Picker for picking; MediaStore write for saving).
 */
object GalleryImageSaver {
  private const val TAG = "GalleryImageSaver"
  private const val ALBUM = "LiVi"

  fun save(context: Context, uriOrPath: String) {
    val raw = uriOrPath.trim()
    if (raw.isEmpty()) throw IllegalArgumentException("Empty image uri")

    val sourceUri = when {
      raw.startsWith("content://", ignoreCase = true) ||
        raw.startsWith("file://", ignoreCase = true) -> Uri.parse(raw)
      raw.startsWith("/") -> Uri.fromFile(File(raw))
      else -> Uri.parse(raw)
    }

    val mime = guessMime(context, sourceUri, raw)
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "jpg"
    val displayName = "livi_${System.currentTimeMillis()}.$ext"

    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
      put(MediaStore.Images.Media.MIME_TYPE, mime)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
    }

    val resolver = context.contentResolver
    val collection =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      } else {
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      }

    val dest = resolver.insert(collection, values)
      ?: throw IllegalStateException("MediaStore insert failed")

    try {
      resolver.openOutputStream(dest)?.use { out ->
        openInput(context, sourceUri, raw).use { input ->
          input.copyTo(out)
        }
      } ?: throw IllegalStateException("Cannot open MediaStore output stream")

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(dest, values, null, null)
      }
      Log.i(TAG, "saved image to gallery uri=$dest")
    } catch (e: Exception) {
      try {
        resolver.delete(dest, null, null)
      } catch (_: Exception) {
      }
      throw e
    }
  }

  private fun openInput(context: Context, uri: Uri, raw: String): InputStream {
    if (uri.scheme.equals("content", ignoreCase = true) ||
      uri.scheme.equals("file", ignoreCase = true)
    ) {
      return context.contentResolver.openInputStream(uri)
        ?: throw IllegalStateException("Cannot open source uri=$uri")
    }
    val path = if (raw.startsWith("/")) raw else (uri.path ?: raw)
    return FileInputStream(File(path))
  }

  private fun guessMime(context: Context, uri: Uri, raw: String): String {
    try {
      val fromResolver = context.contentResolver.getType(uri)
      if (!fromResolver.isNullOrBlank()) return fromResolver
    } catch (_: Exception) {
    }
    val name = (uri.lastPathSegment ?: raw).lowercase(Locale.US)
    return when {
      name.endsWith(".png") -> "image/png"
      name.endsWith(".webp") -> "image/webp"
      name.endsWith(".gif") -> "image/gif"
      name.endsWith(".heic") || name.endsWith(".heif") -> "image/heic"
      else -> "image/jpeg"
    }
  }
}
