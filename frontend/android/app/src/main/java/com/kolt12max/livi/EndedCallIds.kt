package com.kolt12max.livi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Хранит недавно завершённые/отменённые callId, чтобы не показывать IncomingCallActivity,
 * если пользователь открыл уведомление с опозданием (звонок уже отменён инициатором).
 * Обновляется при FCM call_canceled; проверяется в IncomingCallActivity.onCreate.
 */
object EndedCallIds {
    private const val PREFS_NAME = "LiviEndedCallIds"
    private const val KEY_JSON = "ended"
    private const val MAX_AGE_MS = 5 * 60 * 1000L // 5 минут
    private const val MAX_ENTRIES = 100

    private val cache = ConcurrentHashMap<String, Long>()
    private var prefsLoaded = false

    @Synchronized
    private fun ensureLoaded(context: Context) {
        if (prefsLoaded) return
        try {
            val json = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(KEY_JSON, "[]")
            val arr = JSONArray(json ?: "[]")
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val id = obj.optString("id", "")
                val ts = obj.optLong("ts", 0L)
                if (id.isNotEmpty() && ts > 0) cache[id] = ts
            }
        } catch (_: Exception) {}
        prefsLoaded = true
    }

    /** Добавить callId как завершённый (вызывать при FCM call_canceled). */
    @JvmStatic
    fun add(context: Context, callId: String) {
        if (callId.isBlank()) return
        ensureLoaded(context)
        val now = System.currentTimeMillis()
        cache[callId] = now
        pruneAndSave(context)
    }

    /** Закончился ли уже этот звонок (отмена/завершение). Если да — не показывать экран входящего. */
    @JvmStatic
    fun isEnded(context: Context, callId: String): Boolean {
        if (callId.isBlank()) return false
        ensureLoaded(context)
        val ts = cache[callId] ?: return false
        if (System.currentTimeMillis() - ts > MAX_AGE_MS) {
            cache.remove(callId)
            save(context)
            return false
        }
        return true
    }

    private fun pruneAndSave(context: Context) {
        val now = System.currentTimeMillis()
        val toRemove = cache.entries.filter { now - it.value > MAX_AGE_MS }.map { it.key }
        toRemove.forEach { cache.remove(it) }
        while (cache.size > MAX_ENTRIES) {
            val oldest = cache.entries.minByOrNull { it.value }?.key
            if (oldest != null) cache.remove(oldest) else break
        }
        save(context)
    }

    private fun save(context: Context) {
        try {
            val arr = JSONArray()
            cache.entries.take(MAX_ENTRIES).forEach { (id, ts) ->
                arr.put(JSONObject().put("id", id).put("ts", ts))
            }
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_JSON, arr.toString())
                .commit()
        } catch (_: Exception) {}
    }
}
