package com.kolt12max.livi

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

/**
 * Досылает очередь сообщений, пока приложение в фоне.
 *
 * Повторы очереди (2–15 с) и «сеть вернулась» живут на JS-таймерах, а RN не запускает их, пока
 * Activity на паузе; вдобавок Android замораживает фоновый процесс. Сообщение, отправленное без
 * сети перед сворачиванием, уходило только когда человек возвращался в LiVi.
 *
 * Пока в очереди есть сообщения и приложение не на экране, держим задание JobScheduler с условием
 * «есть сеть». Оно будит JS headless-задачей LiviOutboxDrain (с ней JS-таймеры работают и в фоне)
 * и, если очередь не опустела, повторяется с нарастающей паузой. Если процесса нет (выгружен),
 * очередь уйдёт при следующем запуске, как и раньше.
 */
class OutboxDrainJobService : JobService() {
    companion object {
        private const val TAG = "OutboxDrainJob"
        private const val JOB_ID = 0x0B0C0
        const val TASK_KEY = "LiviOutboxDrain"
        /** Один проход очереди с HTTP-обходом зависшего сокета укладывается с запасом. */
        private const val TASK_TIMEOUT_MS = 60_000L
        private const val BACKOFF_MS = 10_000L

        /** В очереди есть сообщения (сообщает JS при каждом изменении очереди). */
        @Volatile private var outboxPending = false
        @Volatile private var running = false

        fun sync(ctx: Context, pending: Boolean, inBackground: Boolean) {
            outboxPending = pending
            val scheduler = ctx.getSystemService(JobScheduler::class.java) ?: return
            if (!pending) {
                if (!running) scheduler.cancel(JOB_ID)
                return
            }
            // На экране очередь досылает сам JS; задание нужно только в фоне.
            if (!inBackground || running || scheduler.getPendingJob(JOB_ID) != null) return
            val builder = JobInfo.Builder(JOB_ID, ComponentName(ctx, OutboxDrainJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(BACKOFF_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setExpedited(true)
            try {
                scheduler.schedule(builder.build())
            } catch (e: Exception) {
                // Квота срочных заданий кончилась — обычное задание всё равно лучше, чем ничего.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        scheduler.schedule(builder.setExpedited(false).build())
                    } catch (e2: Exception) {
                        Log.w(TAG, "schedule failed", e2)
                    }
                } else {
                    Log.w(TAG, "schedule failed", e)
                }
            }
        }
    }

    override fun onStartJob(params: JobParameters): Boolean {
        val reactContext = LiviAppModule.reactContextForBackgroundTask()
        if (reactContext == null || !outboxPending) return false
        running = true
        UiThreadUtil.runOnUiThread {
            try {
                val tasks = HeadlessJsTaskContext.getInstance(reactContext)
                val taskId = tasks.startTask(
                    HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), TASK_TIMEOUT_MS, true),
                )
                tasks.addTaskEventListener(object : HeadlessJsTaskEventListener {
                    override fun onHeadlessJsTaskStart(id: Int) {}
                    override fun onHeadlessJsTaskFinish(id: Int) {
                        if (id != taskId) return
                        tasks.removeTaskEventListener(this)
                        running = false
                        Log.i(TAG, "drain finished, pending=$outboxPending")
                        jobFinished(params, outboxPending)
                    }
                })
                Log.i(TAG, "drain started taskId=$taskId")
            } catch (e: Exception) {
                Log.w(TAG, "drain start failed", e)
                running = false
                jobFinished(params, true)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        running = false
        return outboxPending
    }
}
