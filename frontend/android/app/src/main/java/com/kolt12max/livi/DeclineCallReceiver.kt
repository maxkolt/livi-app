package com.kolt12max.livi

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.net.URL

/**
 * Обработка нажатия «Отклонить» в уведомлении о звонке (heads-up).
 * Отправляем decline по HTTP и снимаем уведомление, не открывая приложение —
 * чтобы не показывался «Deep link received» и не путалось с answer-call.
 */
class DeclineCallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION_DECLINE_CALL) return
        val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
        EndedCallIds.add(context, callId)
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(LiviFirebaseMessagingService.NOTIFICATION_ID_INCOMING_CALL)
        context.stopService(Intent(context, IncomingCallForegroundService::class.java))
        val cancelIntent = Intent(LiviFirebaseMessagingService.ACTION_CALL_CANCELED).apply {
            setPackage(context.packageName)
            putExtra(LiviFirebaseMessagingService.EXTRA_CALL_ID, callId)
        }
        context.sendBroadcast(cancelIntent)
        val prefs = context.getSharedPreferences(LiviAppModule.PREFS_NAME, Context.MODE_PRIVATE)
        val installId = prefs.getString(LiviAppModule.KEY_INSTALL_ID, null)?.takeIf { it.isNotBlank() }
        val serverUrl = prefs.getString(LiviAppModule.KEY_SERVER_URL, null)?.takeIf { it.isNotBlank() }
        if (installId != null && serverUrl != null) {
            Thread {
                try {
                    val url = URL("$serverUrl/api/calls/decline")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("x-install-id", installId)
                    conn.doOutput = true
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.outputStream.use { os ->
                        os.write("{\"callId\":\"${callId.replace("\"", "\\\"")}\"}".toByteArray(Charsets.UTF_8))
                    }
                    val code = conn.responseCode
                    if (code !in 200..299) Log.w(TAG, "decline HTTP $code")
                    conn.disconnect()
                } catch (e: Exception) {
                    Log.w(TAG, "decline HTTP failed", e)
                }
            }.start()
        }
    }

    companion object {
        private const val TAG = "DeclineCallReceiver"
        const val ACTION_DECLINE_CALL = "com.kolt12max.livi.DECLINE_CALL"
        const val EXTRA_CALL_ID = "callId"
    }
}
