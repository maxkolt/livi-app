import { hasFreshTurnCredentials, isTurnUrl, turnCredentialExpiry } from '../../../../utils/turnCredentialLifetime';

// The pinned RN WebRTC has no getConfiguration(). LiveKit retains the native
// configuration (including E2EE flags) on its PCTransport instead.
type IceTransport = { config?: RTCConfiguration };
export type IceRefreshRoom = {
  state: string;
  engine?: unknown;
};
type IceRefreshEngine = {
    rtcConfig: RTCConfiguration;
    pcManager?: {
      publisher: IceTransport;
      updateConfiguration(config: RTCConfiguration, restartIce?: boolean): void;
    };
};

const RETRY_MS = 15_000;
const RENEW_AHEAD_MS = 60_000;

function deadline(config: RTCConfiguration): number | null {
  const expirations = (config.iceServers || []).filter(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(isTurnUrl);
  }).map(turnCredentialExpiry).filter((value): value is number => value !== null);
  return expirations.length ? Math.min(...expirations) - RENEW_AHEAD_MS : null;
}

/** Renew temporary credentials without renegotiating or replacing healthy media. */
export class IceCredentialRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private readonly fetchConfiguration: () => Promise<RTCConfiguration>) {}

  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  start(room: IceRefreshRoom, isCurrent: () => boolean): void {
    this.stop();
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent();
    const schedule = (delay: number) => {
      if (!current()) return;
      this.timer = setTimeout(() => { this.timer = null; void renew(); }, Math.max(1000, delay));
    };
    const plan = (config: RTCConfiguration) => {
      const at = deadline(config);
      if (at !== null) schedule(at - Date.now());
    };
    const renew = async () => {
      if (!current()) return;
      if (room.state !== 'connected') { schedule(RETRY_MS); return; }
      try {
        const fresh = await this.fetchConfiguration();
        if (!current()) return;
        if (room.state !== 'connected') { schedule(RETRY_MS); return; }
        const hasTurn = fresh.iceServers?.some(server => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some(isTurnUrl) && hasFreshTurnCredentials(server, Date.now());
        });
        const engine = room.engine as IceRefreshEngine | undefined;
        const manager = engine?.pcManager;
        if (!hasTurn || !engine || !manager) { schedule(RETRY_MS); return; }
        // Keep E2EE/native configuration and the currently selected relay policy.
        // A fresh object also avoids mutating configuration frozen by RN debug builds.
        const servers = fresh.iceServers!.map(server => ({ ...server, urls: Array.isArray(server.urls) ? [...server.urls] : server.urls }));
        const config = { ...(manager.publisher.config || engine.rtcConfig), iceServers: servers };
        manager.updateConfiguration(config, false);
        engine.rtcConfig = { ...engine.rtcConfig, iceServers: servers };
        plan(config);
      } catch {
        // Do not discard a healthy connection or install STUN-only fallback on a failed refresh.
        schedule(RETRY_MS);
      }
    };
    try {
      const engine = room.engine as IceRefreshEngine | undefined;
      const config = engine?.pcManager?.publisher.config || engine?.rtcConfig;
      if (config) plan(config);
    } catch { schedule(RETRY_MS); }
  }
}
