package com.kolt12max.livi

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * На время звонка держит JS-таймеры живыми, когда Activity на паузе (системный PiP, фон).
 *
 * RN останавливает setTimeout/setInterval в onHostPause (JavaTimerManager), если нет активной
 * headless-задачи. LiveKit переподключается на таймерах — свёрнутый в PiP звонок после смены
 * сети (VPN off) молчал, пока пользователь не вернётся в приложение (~8 с).
 *
 * Задача в JS — вечный Promise (index.tsx); завершаем её отсюда, когда звонок закончился.
 */
object CallJsTimersKeepAlive {
  const val TASK_KEY = "LiviCallJsTimersKeepAlive"
  private const val TAG = "CallJsTimersKeepAlive"

  // Только UI thread.
  private var taskId: Int? = null
  private var taskContext: HeadlessJsTaskContext? = null

  fun start(reactContext: ReactContext?) {
    if (reactContext == null) return
    UiThreadUtil.runOnUiThread {
      try {
        val running = taskId?.let { taskContext?.isTaskRunning(it) } == true
        if (running) return@runOnUiThread
        if (!reactContext.hasActiveReactInstance()) {
          Log.w(TAG, "start skipped: no active React instance")
          return@runOnUiThread
        }
        val ctx = HeadlessJsTaskContext.getInstance(reactContext)
        taskId = ctx.startTask(
          HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), 0L, true),
        )
        taskContext = ctx
        Log.i(TAG, "started taskId=$taskId")
      } catch (e: Exception) {
        Log.w(TAG, "start failed", e)
      }
    }
  }

  fun stop() {
    UiThreadUtil.runOnUiThread {
      val id = taskId ?: return@runOnUiThread
      val ctx = taskContext
      taskId = null
      taskContext = null
      try {
        ctx?.finishTask(id)
        Log.i(TAG, "finished taskId=$id")
      } catch (e: Exception) {
        Log.w(TAG, "finish failed", e)
      }
    }
  }
}
