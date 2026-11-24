package com.kolt12max.livi

import org.junit.Assert.*
import org.junit.Test

class ByteBudgetLruTest {
  @Test fun largeImagesEvictByBytesAndKeepLiveReferencesValid() {
    val cache = ByteBudgetLru<String, ByteArray>(10, 10) { it.size.toLong() }
    val live = ByteArray(6)
    cache.put("portrait", live)
    cache.put("landscape", ByteArray(6))
    assertNull(cache["portrait"])
    assertEquals(6, live.size)
    assertEquals(6L, cache.bytes)
  }
  @Test fun recentAccessAndReplacementsAreAccountedFor() {
    val cache = ByteBudgetLru<String, Int>(2, 10) { it.toLong() }
    cache.put("a", 4); cache.put("b", 4)
    assertEquals(4, cache["a"])
    cache.put("c", 4)
    assertNull(cache["b"])
    cache.put("a", 7)
    assertNull(cache["c"])
    assertEquals(7L, cache.bytes)
    cache.clear()
    assertEquals(0L, cache.bytes)
  }
  @Test fun anOversizedImageIsDeliveredWithoutBeingRetainedByTheCache() {
    val cache = ByteBudgetLru<String, Int>(5, 10) { it.toLong() }
    cache.put("oversized", 20)
    assertNull(cache["oversized"])
    assertEquals(0L, cache.bytes)
  }
}
