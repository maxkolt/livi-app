type PeerConnectionLike = {
  getStats: () => Promise<any>;
  iceConnectionState?: string;
  connectionState?: string;
};

export type IceTransportDiagnostic = {
  source: string;
  usingRelay: boolean;
  selectedCandidatePairId: string | null;
  localCandidateType: string | null;
  localProtocol: string | null;
  localRelayProtocol: string | null;
  localUrl: string | null;
  remoteCandidateType: string | null;
  remoteProtocol: string | null;
  remoteAddress: string | null;
  networkType: string | null;
  currentRoundTripTime: number | null;
  availableOutgoingBitrate: number | null;
  availableIncomingBitrate: number | null;
  iceConnectionState: string | null;
  connectionState: string | null;
};

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}

function isPeerConnectionLike(value: unknown): value is PeerConnectionLike {
  return isObject(value) && typeof (value as any).getStats === 'function';
}

function normalizeStats(report: any): any[] {
  if (!report) return [];
  if (Array.isArray(report)) return report.filter(Boolean);
  if (typeof report.values === 'function') {
    try {
      return Array.from(report.values()).filter(Boolean);
    } catch {}
  }
  if (typeof report.forEach === 'function') {
    const out: any[] = [];
    try {
      report.forEach((value: any) => {
        if (value) out.push(value);
      });
      if (out.length > 0) return out;
    } catch {}
  }
  if (isObject(report)) return Object.values(report).filter(Boolean);
  return [];
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstCandidatePair(stats: any[], byId: Map<string, any>): any | null {
  const transport = stats.find((stat) => stat?.type === 'transport' && stat?.selectedCandidatePairId);
  if (transport?.selectedCandidatePairId && byId.has(String(transport.selectedCandidatePairId))) {
    return byId.get(String(transport.selectedCandidatePairId)) || null;
  }

  const selected = stats.find((stat) => stat?.type === 'candidate-pair' && stat?.selected === true);
  if (selected) return selected;

  const nominated = stats.find(
    (stat) => stat?.type === 'candidate-pair' && stat?.nominated === true && stat?.state === 'succeeded'
  );
  if (nominated) return nominated;

  const succeeded = stats
    .filter((stat) => stat?.type === 'candidate-pair' && stat?.state === 'succeeded')
    .sort((a, b) => {
      const scoreA = Number(a?.bytesReceived || 0) + Number(a?.bytesSent || 0);
      const scoreB = Number(b?.bytesReceived || 0) + Number(b?.bytesSent || 0);
      return scoreB - scoreA;
    });
  return succeeded[0] || null;
}

function collectPeerConnections(root: any): Array<{ source: string; pc: PeerConnectionLike }> {
  const results: Array<{ source: string; pc: PeerConnectionLike }> = [];
  const seenObjects = new WeakSet<object>();
  const seenPcs = new WeakSet<object>();

  const seedEntries: Array<[string, any]> = [
    ['room.engine.publisher', root?.engine?.publisher],
    ['room.engine.subscriber', root?.engine?.subscriber],
    ['room.engine', root?.engine],
  ];

  const walk = (value: any, path: string, depth: number) => {
    if (!isObject(value)) return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (isPeerConnectionLike(value)) {
      if (!seenPcs.has(value)) {
        seenPcs.add(value);
        results.push({ source: path, pc: value });
      }
      return;
    }

    if (depth <= 0) return;

    const preferredKeys = ['pc', 'peerConnection', 'publisher', 'subscriber', 'pcManager', 'transportManager'];
    const objectKeys = Object.keys(value);
    const interestingKeys = objectKeys.filter((key) => /(pc|peer|publisher|subscriber|transport|engine)/i.test(key));
    const keys = Array.from(new Set([...preferredKeys, ...interestingKeys])).filter((key) => key in value);

    for (const key of keys) {
      try {
        walk((value as any)[key], `${path}.${key}`, depth - 1);
      } catch {}
    }
  };

  for (const [path, value] of seedEntries) {
    walk(value, path, 5);
  }

  return results;
}

async function inspectPeerConnection(source: string, pc: PeerConnectionLike): Promise<IceTransportDiagnostic | null> {
  try {
    const stats = normalizeStats(await pc.getStats());
    if (stats.length === 0) return null;

    const byId = new Map<string, any>();
    for (const stat of stats) {
      const id = firstString(stat?.id);
      if (id) byId.set(id, stat);
    }

    const pair = firstCandidatePair(stats, byId);
    if (!pair) {
      return {
        source,
        usingRelay: false,
        selectedCandidatePairId: null,
        localCandidateType: null,
        localProtocol: null,
        localRelayProtocol: null,
        localUrl: null,
        remoteCandidateType: null,
        remoteProtocol: null,
        remoteAddress: null,
        networkType: null,
        currentRoundTripTime: null,
        availableOutgoingBitrate: null,
        availableIncomingBitrate: null,
        iceConnectionState: firstString((pc as any).iceConnectionState),
        connectionState: firstString((pc as any).connectionState),
      };
    }

    const localCandidate = byId.get(String(pair.localCandidateId || '')) || null;
    const remoteCandidate = byId.get(String(pair.remoteCandidateId || '')) || null;
    const localCandidateType = firstString(localCandidate?.candidateType);
    const remoteCandidateType = firstString(remoteCandidate?.candidateType);

    return {
      source,
      usingRelay: localCandidateType === 'relay' || remoteCandidateType === 'relay',
      selectedCandidatePairId: firstString(pair.id),
      localCandidateType,
      localProtocol: firstString(localCandidate?.protocol, pair?.localCandidateProtocol),
      localRelayProtocol: firstString(localCandidate?.relayProtocol),
      localUrl: firstString(localCandidate?.url),
      remoteCandidateType,
      remoteProtocol: firstString(remoteCandidate?.protocol),
      remoteAddress: firstString(remoteCandidate?.address, remoteCandidate?.ip, remoteCandidate?.ipAddress),
      networkType: firstString(localCandidate?.networkType),
      currentRoundTripTime: asNumber(pair.currentRoundTripTime),
      availableOutgoingBitrate: asNumber(pair.availableOutgoingBitrate),
      availableIncomingBitrate: asNumber(pair.availableIncomingBitrate),
      iceConnectionState: firstString((pc as any).iceConnectionState),
      connectionState: firstString((pc as any).connectionState),
    };
  } catch {
    return null;
  }
}

export async function getRoomIceTransportDiagnostics(room: any): Promise<IceTransportDiagnostic[]> {
  const pcs = collectPeerConnections(room);
  const diagnostics = await Promise.all(pcs.map(({ source, pc }) => inspectPeerConnection(source, pc)));
  return diagnostics.filter((value): value is IceTransportDiagnostic => !!value);
}
