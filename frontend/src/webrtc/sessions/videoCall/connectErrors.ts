/**
 * Классификация ошибок LiveKit-подключения и публикации треков.
 *
 * Эти предикаты решают, что делать с упавшей операцией: молча проглотить, уйти в
 * relay-only ретрай, один раз предупредить про ключи или сломать звонок. Раньше одни и те
 * же наборы `includes(...)` были скопированы по пяти местам VideoCallSession — разъехалась
 * бы одна копия, и звонок падал бы там, где раньше восстанавливался.
 */

/** Токен/ключ не приняли: почти всегда транзиентно при reconnect / смене комнаты. */
export function isInvalidApiKeyError(message: string): boolean {
  const msg = String(message || '');
  return msg.includes('invalid API key') || msg.includes('401') || msg.includes('Unauthorized');
}

/** Разрыв инициировали мы сами (endCall / смена комнаты) — это не сбой. */
export function isClientDisconnectError(message: string): boolean {
  const msg = String(message || '');
  return msg.includes('Client initiated disconnect') || msg.includes('user initiated disconnect');
}

/**
 * Не поднялся PeerConnection: VPN / жёсткий NAT / медленный ICE.
 * Повод для одной попытки через TURN relay-only, а не для ошибки звонка.
 */
export function isTransientPcConnectionError(message: string): boolean {
  return /could not establish pc connection|pc connection|negotiation (disconnected|timed out)|transport error|ice (failed|disconnected)/i.test(
    String(message || ''),
  );
}

/**
 * Публикация не прошла, потому что трек уже опубликован или соединение закрылось.
 * Гонка publish/unpublish — ожидаемая, звук и картинка от неё не страдают.
 */
export function isIgnorablePublishError(message: string): boolean {
  const msg = String(message || '');
  return (
    msg.includes('already') ||
    msg.includes('duplicate') ||
    msg.includes('closed') ||
    msg.includes('disconnected')
  );
}

/** DNS не разрешился (смена сети / DNS ещё не поднялся) — повод повторить connect. */
export function isLikelyDnsResolutionError(message: string): boolean {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('unable to resolve host') ||
    msg.includes('ename_not_resolved') ||
    msg.includes('dns') ||
    msg.includes('host lookup')
  );
}
