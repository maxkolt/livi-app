package com.kolt12max.livi

/** Eviction drops cache ownership only; live Views may still own the same resource. */
internal class ByteBudgetLru<K, V>(private val maxEntries: Int, private val maxBytes: Long, private val sizeOf: (V) -> Long) {
  private val entries = LinkedHashMap<K, V>(16, 0.75f, true)
  var bytes: Long = 0
    private set
  operator fun get(key: K): V? = entries[key]
  fun put(key: K, value: V) {
    entries.remove(key)?.let { bytes -= sizeOf(it) }
    entries[key] = value
    bytes += sizeOf(value)
    trimTo(maxBytes)
  }
  fun trimTo(targetBytes: Long) {
    while (entries.isNotEmpty() && (entries.size > maxEntries || bytes > targetBytes.coerceAtLeast(0))) {
      val iterator = entries.entries.iterator()
      bytes -= sizeOf(iterator.next().value)
      iterator.remove()
    }
  }
  fun clear() { entries.clear(); bytes = 0 }
}
