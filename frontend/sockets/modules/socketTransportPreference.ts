type TransportName = 'websocket' | 'polling';

function transportName(value: unknown): string {
  if (typeof value === 'string') return value;
  // Engine.IO replaces option strings with constructors when opening a connection.
  // The transport name is an inherited getter, not the JS constructor's name.
  if (typeof value === 'function') return String(value.prototype?.name || '');
  return '';
}

export function nextSocketTransportOrder(
  transports: readonly unknown[],
  failedHint: string,
): [TransportName, TransportName] | null {
  const names = transports.map(transportName);
  if (!names.includes('websocket') || !names.includes('polling')) return null;
  const current = names[0];
  const error = failedHint.toLowerCase();
  let preferred: TransportName;
  if (error.includes('xhr poll') || (error.includes('polling') && !error.includes('websocket'))) {
    preferred = 'websocket';
  } else if (error.includes('websocket')) {
    preferred = 'polling';
  } else if (error.includes('timeout') || error.includes('transport error')) {
    preferred = current === 'websocket' ? 'polling' : 'websocket';
  } else {
    return null;
  }
  if (preferred === current) return null;
  return preferred === 'websocket' ? ['websocket', 'polling'] : ['polling', 'websocket'];
}
