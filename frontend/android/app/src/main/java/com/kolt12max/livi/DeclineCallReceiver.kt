package com.kolt12max.livi

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
        val serverUrl = LiviAppModule.resolveServerBaseUrl(context)
        val userIdHeader = prefs.getString(LiviAppModule.KEY_USER_ID_FOR_DECLINE, null)?.takeIf { it.isNotBlank() }
        val declineUri = "livi://decline-call?callId=${Uri.encode(callId)}"
        if (installId != null && serverUrl != null) {
            Thread {
                var httpOk = false
                try {
                    val url = URL("$serverUrl/api/calls/decline")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("x-install-id", installId)
                    if (userIdHeader != null) {
                        conn.setRequestProperty("x-user-id", userIdHeader)
                    }
                    conn.doOutput = true
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.outputStream.use { os ->
                        os.write("{\"callId\":\"${callId.replace("\"", "\\\"")}\"}".toByteArray(Charsets.UTF_8))
                    }
                    val code = conn.responseCode
                    httpOk = code in 200..299
                    if (!httpOk) Log.e(TAG, "decline HTTP code=$code callId=$callId (fallback deep link)")
                    conn.disconnect()
                } catch (e: Exception) {
                    Log.e(TAG, "decline HTTP failed callId=$callId (fallback deep link)", e)
                }
                if (!httpOk) {
                    Handler(Looper.getMainLooper()).post {
                        try {
                            val i = Intent(Intent.ACTION_VIEW, Uri.parse(declineUri)).apply {
                                setClassName(context, "com.kolt12max.livi.MainActivity")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                            }
                            context.startActivity(i)
                        } catch (e: Exception) {
                            Log.e(TAG, "decline fallback startActivity failed", e)
                        }
                    }
                }
            }.start()
        } else {
            Log.w(TAG, "decline from notification: no installId/serverUrl, opening app with decline deep link")
            Handler(Looper.getMainLooper()).post {
                try {
                    val i = Intent(Intent.ACTION_VIEW, Uri.parse(declineUri)).apply {
                        setClassName(context, "com.kolt12max.livi.MainActivity")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    }
                    context.startActivity(i)
                } catch (e: Exception) {
                    Log.e(TAG, "decline deep link from receiver failed", e)
                }
            }
        }
    }

    companion object {
        private const val TAG = "DeclineCallReceiver"
        const val ACTION_DECLINE_CALL = "com.kolt12max.livi.DECLINE_CALL"
        const val EXTRA_CALL_ID = "callId"
    }
}
