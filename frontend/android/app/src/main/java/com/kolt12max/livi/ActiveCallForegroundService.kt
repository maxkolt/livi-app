package com.kolt12max.livi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground-сервис во время активного видеозвонка (в т.ч. в PiP).
 * Держит процесс в статусе «foreground», чтобы Android не глушил сокет и сеть в фоне.
 * По тапу на уведомление открывается MainActivity.
 */
class ActiveCallForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        partnerNick = intent?.getStringExtra(EXTRA_PARTNER_NICK)?.trim()?.takeIf { it.isNotEmpty() }
        // Явно указываем тип FGS, чтобы Android 13+ корректно трекал policy для phoneCall-сервиса.
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), fgsType)
        try {
            val p = org.json.JSONObject()
                .put("source", "active_call_service")
                .put("appForeground", MainActivity.isInForeground)
                .toString()
            if (!MainActivity.isInForeground) {
                LiviAppModule.trackAppEventStatic(applicationContext, "fgs_start_background", p)
            }
        } catch (_: Exception) {}
        return START_STICKY
    }

    private var partnerNick: String? = null

    private fun buildNotification(): Notification {
        val channelId = CHANNEL_ID
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                getString(R.string.active_call_notification_channel),
                NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }

        val title = if (!partnerNick.isNullOrEmpty()) {
            getString(R.string.active_call_notification_title_from, partnerNick)
        } else {
            getString(R.string.active_call_notification_title_someone)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(MainActivity.EXTRA_RETURN_TO_ACTIVE_CALL, true)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle(title)
            .setContentText(getString(R.string.active_call_notification_text))
            .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_menu_call)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    companion object {
        private const val TAG = "ActiveCallFg"
        private const val CHANNEL_ID = "livi_active_call_channel"
        private const val NOTIFICATION_ID = 1004
        private const val EXTRA_PARTNER_NICK = "partnerNick"

        fun start(context: Context, partnerNick: String?) {
            val intent = Intent(context, ActiveCallForegroundService::class.java).apply {
                putExtra(EXTRA_PARTNER_NICK, partnerNick?.takeIf { it.isNotBlank() } ?: "")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            android.util.Log.d(TAG, "ActiveCallForegroundService started partnerNick=${partnerNick?.take(20)}")
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ActiveCallForegroundService::class.java))
            android.util.Log.d(TAG, "ActiveCallForegroundService stop requested")
        }
    }
}
