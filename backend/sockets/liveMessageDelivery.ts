import { socketSupportsOfflineAck } from './offlineMessageDelivery';

/**
 * Живая доставка сообщения с подтверждением.
 *
 * «Сокет получателя в комнате» ещё не значит «сообщение дошло»: при пропаже сети
 * (VPN, лифт, режим полёта) сервер считает сокет живым до таймаута пинга, и emit
 * уходит в пустоту — ни офлайн-очереди, ни пуша. Новые клиенты подтверждают приём
 * (после записи на диск); нет подтверждения за LIVE_DELIVERY_ACK_TIMEOUT_MS —
 * onUnconfirmed кладёт сообщение в офлайн-очередь и шлёт пуш. Если хотя бы один
 * сокет получателя — старое приложение (не подтверждает), шлём как раньше.
 */

export const LIVE_DELIVERY_ACK_TIMEOUT_MS = 8_000;

export type LiveDeliveryResult = 'offline' | 'legacy' | 'awaiting_ack';

type HandshakeSocket = { handshake?: { query?: Record<string, unknown> } };
type AckBroadcast = {
  emit: (event: string, payload: unknown, cb: (err: unknown, responses: unknown[]) => void) => unknown;
};
export type LiveDeliveryIo = {
  in: (room: string) => { fetchSockets: () => Promise<HandshakeSocket[]> };
  to: (room: string) => {
    emit: (event: string, payload: unknown) => unknown;
    timeout: (ms: number) => AckBroadcast;
  };
};

export async function deliverLiveMessage(
  io: LiveDeliveryIo,
  recipientId: string,
  payload: unknown,
  onUnconfirmed: () => void,
): Promise<LiveDeliveryResult> {
  const room = `u:${String(recipientId)}`;
  let sockets: HandshakeSocket[] = [];
  try {
    sockets = await io.in(room).fetchSockets();
  } catch {
    sockets = [];
  }
  if (sockets.length === 0) return 'offline';
  if (!sockets.every((s) => socketSupportsOfflineAck(s))) {
    io.to(room).emit('message:received', payload);
    return 'legacy';
  }
  io.to(room)
    .timeout(LIVE_DELIVERY_ACK_TIMEOUT_MS)
    .emit('message:received', payload, (_err, responses) => {
      // err — не все сокеты ответили; достаточно одного, записавшего сообщение.
      const confirmed = Array.isArray(responses) && responses.some((r: any) => r?.ok === true);
      if (!confirmed) {
        try {
          onUnconfirmed();
        } catch (e: any) {
          console.warn('[messages] live delivery fallback failed:', e?.message || e);
        }
      }
    });
  return 'awaiting_ack';
}
