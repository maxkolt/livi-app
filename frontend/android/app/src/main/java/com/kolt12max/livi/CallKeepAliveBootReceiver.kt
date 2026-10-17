package com.kolt12max.livi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * «Надёжные звонки» должны работать и после перезагрузки или обновления приложения — без
 * обязательного открытия LiVi. Оба события входят в исключения для старта FGS из фона.
 */
class CallKeepAliveBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED -> CallKeepAliveService.startIfEnabled(context, intent.action ?: "boot")
    }
  }
}
