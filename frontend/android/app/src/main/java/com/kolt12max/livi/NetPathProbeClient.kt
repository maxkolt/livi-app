package com.kolt12max.livi

import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import java.util.concurrent.TimeUnit

/** A route probe must test a new connection, not an idle connection left by the last probe. */
internal fun createNetPathProbeClient(dns: Dns, timeoutSeconds: Long): OkHttpClient =
  OkHttpClient.Builder()
    .dns(dns)
    .protocols(listOf(Protocol.HTTP_1_1))
    // VPNs can silently discard idle TCP connections before the next 60-second probe.
    // Reusing one with retries disabled caused false failures and direct/relay oscillation.
    .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
    .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
    .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
    .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
    .retryOnConnectionFailure(true)
    .build()
