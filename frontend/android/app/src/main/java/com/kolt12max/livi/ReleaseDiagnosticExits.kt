package com.kolt12max.livi

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray

/** Android's own exit history, read only after the next launch; no trace files or user data. */
object ReleaseDiagnosticExits {
  fun read(context: Context, since: Long): WritableArray {
    val result = Arguments.createArray()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return result
    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return result
    val reasons = mapOf(
      ApplicationExitInfo.REASON_CRASH to "crash",
      ApplicationExitInfo.REASON_CRASH_NATIVE to "native_crash",
      ApplicationExitInfo.REASON_ANR to "anr"
    )
    for (exit in activityManager.getHistoricalProcessExitReasons(context.packageName, 0, 16)) {
      val code = reasons[exit.reason] ?: continue
      if (exit.timestamp <= since) continue
      if (exit.processName != context.packageName) continue
      val row = Arguments.createMap()
      row.putDouble("at", exit.timestamp.toDouble())
      row.putString("code", code)
      result.pushMap(row)
    }
    return result
  }
}
