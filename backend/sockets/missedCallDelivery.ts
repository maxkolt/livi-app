import type { Socket } from 'socket.io';
import MissedCall from '../models/MissedCall';

export type MissedCallDelivery = {
  id: string;
  callId?: string;
  from: string;
  fromNick: string;
  at: number;
};

export function supportsMissedCallAck(sock: Pick<Socket, 'handshake'>): boolean {
  return String(sock.handshake?.query?.caps || '').split(',').includes('missed_calls_ack');
}

export async function getPendingMissedCalls(sock: Pick<Socket, 'handshake'>, userId: string): Promise<MissedCallDelivery[]> {
  const docs = await MissedCall.find({ calleeId: userId }).sort({ createdAt: 1 }).limit(50).lean();
  const missed = docs.map((d: any) => ({
    id: String(d._id),
    callId: d.callId ? String(d.callId) : undefined,
    from: String(d.callerId),
    fromNick: String(d.callerNick || '').trim(),
    at: new Date(d.createdAt).getTime(),
  }));
  // Old releases cannot acknowledge receipt. Keep their existing delivery contract.
  if (docs.length && !supportsMissedCallAck(sock)) {
    await MissedCall.deleteMany({ calleeId: userId, _id: { $in: docs.map((d: any) => d._id) } });
  }
  return missed;
}

export function registerMissedCallAck(sock: Socket): void {
  sock.on('missed_calls:ack', async (payload, ack) => {
    const userId = String(sock.data?.userId || '');
    const ids = payload?.ids;
    if (!/^[a-f\d]{24}$/i.test(userId) || !supportsMissedCallAck(sock) ||
        !Array.isArray(ids) || !ids.length || ids.length > 50 ||
        !ids.every((id: unknown) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id))) {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_missed_ack' });
      return;
    }
    try {
      // Only the authenticated recipient may acknowledge these records.
      await MissedCall.deleteMany({ calleeId: userId, _id: { $in: ids } });
      const missed = await getPendingMissedCalls(sock, userId);
      if (typeof ack === 'function') ack({ ok: true, userId, missed });
    } catch {
      if (typeof ack === 'function') ack({ ok: false, error: 'missed_ack_failed' });
    }
  });
}
