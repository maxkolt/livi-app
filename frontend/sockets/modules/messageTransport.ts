/** A connected socket can be silent after a VPN change. Hedge with the same message ID. */
export function sendWithHttpFallback<T extends { ok: boolean; error?: string }>(
  sendSocket: ((signal: AbortSignal) => Promise<T>) | null,
  sendHttp: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  hedgeAfterMs = 1200,
): Promise<{ resp: T; usedHttp: boolean }> {
  return new Promise((resolve, reject) => {
    const socketController = new AbortController();
    const httpController = new AbortController();
    let settled = false;
    let httpStarted = false;
    let socketDone = !sendSocket;
    let httpDone = false;
    let socketResponse: T | undefined;
    let httpResponse: T | undefined;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let socketTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (resp?: T, usedHttp = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(socketTimer);
      signal.removeEventListener('abort', onAbort);
      socketController.abort();
      httpController.abort();
      if (resp) resolve({ resp, usedHttp });
      else reject(new Error('message transport unavailable'));
    };
    const onAbort = () => finish();
    const finishIfDone = () => {
      if (socketDone && httpDone) finish(httpResponse || socketResponse, !!httpResponse);
    };
    const startHttp = () => {
      if (settled || httpStarted) return;
      httpStarted = true;
      Promise.resolve().then(() => sendHttp(httpController.signal)).then((resp) => {
        httpDone = true;
        httpResponse = resp;
        if (resp?.ok) finish(resp, true);
        else finishIfDone();
      }, () => {
        httpDone = true;
        finishIfDone();
      });
    };

    if (signal.aborted) { finish(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    if (!sendSocket) { startHttp(); return; }
    // Includes reauth: a stuck authentication ACK must not hold the entire durable queue.
    hedgeTimer = setTimeout(startHttp, hedgeAfterMs);
    socketTimer = setTimeout(() => {
      socketDone = true;
      socketController.abort();
      startHttp();
      finishIfDone();
    }, 8000);
    Promise.resolve().then(() => sendSocket(socketController.signal)).then((resp) => {
      if (settled || socketDone) return;
      socketDone = true;
      clearTimeout(socketTimer);
      if (resp?.ok || (!httpStarted && resp?.error !== 'unauthorized')) {
        finish(resp);
      } else {
        if (resp?.error !== 'unauthorized') socketResponse = resp;
        startHttp();
        finishIfDone();
      }
    }, () => {
      if (settled || socketDone) return;
      socketDone = true;
      clearTimeout(socketTimer);
      startHttp();
      finishIfDone();
    });
  });
}
