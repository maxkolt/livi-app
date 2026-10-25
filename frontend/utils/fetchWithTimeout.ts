/**
 * fetch с таймаутом. Под VPN новое соединение к серверу висит 15–33 с, а иногда не отвечает
 * вовсе; без таймаута запрос — и экран, который ждёт его ответа, — не заканчивается никогда.
 * Внешний signal (если передан) тоже отменяет запрос.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort());
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
