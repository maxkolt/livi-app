import socket from '../sockets/socket';
import { dispatchPartnerExternalHoldFromSocket } from './partnerExternalHoldUi';

/** Партнёрский hold на __webrtcSessionRef (не тянем socket в externalCallHold.ts — break require cycle). */
export function installExternalHoldSocketRelay(): void {
  const g = global as any;
  if (g.__externalHoldSocketRelayInstalled) return;
  g.__externalHoldSocketRelayInstalled = true;
  socket.on('call:external-hold', (data: { hold?: boolean; from: string; roomId?: string }) => {
    if (data.from && data.from === socket.id) return;
    dispatchPartnerExternalHoldFromSocket(data.hold === true, data.roomId ?? null);
  });
}
