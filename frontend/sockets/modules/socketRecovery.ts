type RecoverableSocket = {
  io?: { engine?: { transport?: { close?: () => unknown }; close?: () => unknown } };
};

/** Namespace DISCONNECT means the user left; close only the broken transport instead. */
export function closeSocketTransportForRecovery(socket: RecoverableSocket): void {
  const engine = socket.io?.engine;
  // Close transport first: Engine.IO.close() alone waits for a buffered write to drain,
  // which can never happen on a dead VPN route.
  try { engine?.transport?.close?.(); } catch {}
  try { engine?.close?.(); } catch {}
}
