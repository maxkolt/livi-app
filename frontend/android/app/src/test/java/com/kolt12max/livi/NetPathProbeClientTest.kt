package com.kolt12max.livi

import okhttp3.Dns
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NetPathProbeClientTest {
  @Test fun successiveProbesOpenFreshConnectionsInsteadOfTrustingAnIdleVpnSocket() {
    val server = ServerSocket(0, 4, InetAddress.getLoopbackAddress())
    server.soTimeout = 5000
    val worker = Executors.newSingleThreadExecutor()
    val client = createNetPathProbeClient(Dns.SYSTEM, 5)
    try {
      val accepted = worker.submit<Int> {
        repeat(2) {
          server.accept().use { socket ->
            socket.soTimeout = 5000
            val input = socket.getInputStream().bufferedReader()
            while (!input.readLine().isNullOrEmpty()) { /* consume request headers */ }
            socket.getOutputStream().apply {
              write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nOK".toByteArray())
              flush()
            }
            // A cached socket would remain here or receive the second request.
            assertEquals("probe must close its idle connection", -1, input.read())
          }
        }
        2
      }
      repeat(2) {
        val request = Request.Builder().url("http://127.0.0.1:${server.localPort}/health").build()
        client.newCall(request).execute().use { response ->
          assertEquals(200, response.code)
          assertEquals("OK", response.body!!.string())
        }
      }
      assertEquals(2, accepted.get(8, TimeUnit.SECONDS))
    } finally {
      server.close()
      worker.shutdownNow()
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdownNow()
    }
  }
}
