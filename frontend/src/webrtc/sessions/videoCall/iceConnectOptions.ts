/**
 * Передача клиентского ICE/TURN-конфига в LiveKit.
 *
 * ВАЖНО, откуда взялся этот модуль: приложение грузит TURN-креды с /api/turn-credentials
 * и раньше клало результат в `new Room({ rtcConfig })`. Но livekit-client читает rtcConfig
 * из ОПЦИЙ CONNECT (`connOptions.rtcConfig`), а не из опций конструктора — в публичном
 * `RoomOptions` такого поля нет вовсе. То есть конфиг молча терялся, а вместе с ним и
 * relay-only ретрай после «could not establish pc connection» на VPN / жёстком NAT.
 *
 * При этом передавать конфиг нужно осторожно. В makeRTCConfiguration у livekit:
 *
 *     if (serverResponse.iceServers && !rtcConfig.iceServers) { ...взять серверные... }
 *
 * То есть наш список iceServers ПОЛНОСТЬЮ вытесняет тот, что прислал SFU. Поэтому свой
 * конфиг отдаём только когда в нём есть работающий TURN (url + креды) — ради него всё и
 * затевалось. Если своего TURN нет (бэкенд отдал STUN-only или запрос не прошёл), молчим
 * и оставляем LiveKit его собственные серверы: это ровно то поведение, что работает сейчас.
 */

export type IceServerLike = {
  urls?: string | string[];
  username?: string;
  credential?: string;
};

function urlList(server: IceServerLike | undefined): string[] {
  const urls = server?.urls;
  if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === 'string');
  return typeof urls === 'string' ? [urls] : [];
}

/** Есть ли в конфиге TURN, которым реально можно пользоваться: и адрес, и креды. */
export function hasUsableTurnServer(config: RTCConfiguration | null | undefined): boolean {
  const servers = (config as { iceServers?: IceServerLike[] } | null | undefined)?.iceServers;
  if (!Array.isArray(servers)) return false;
  return servers.some(
    (server) => urlList(server).some((url) => url.startsWith('turn:') || url.startsWith('turns:')) &&
      !!server?.username &&
      !!server?.credential,
  );
}

/**
 * Конфиг, который стоит отдать в room.connect().
 * undefined — «не вмешиваемся, пусть LiveKit берёт серверные ICE-серверы».
 */
export function resolveConnectRtcConfig(
  config: RTCConfiguration | undefined,
  options?: { enabled?: boolean },
): RTCConfiguration | undefined {
  if (options?.enabled === false) return undefined;
  if (!config) return undefined;
  return hasUsableTurnServer(config) ? config : undefined;
}

export type LiveKitConnectOptionsInput = {
  peerConnectionTimeoutMs: number;
  rtcConfig?: RTCConfiguration;
  /** Kill-switch: false → ведём себя как до фикса (свой ICE не передаём). */
  applyClientIce?: boolean;
};

export type LiveKitConnectRoomOptions = {
  autoSubscribe: true;
  peerConnectionTimeout: number;
  rtcConfig?: RTCConfiguration;
};

export function buildLiveKitConnectOptions(input: LiveKitConnectOptionsInput): LiveKitConnectRoomOptions {
  const rtcConfig = resolveConnectRtcConfig(input.rtcConfig, { enabled: input.applyClientIce });
  return {
    autoSubscribe: true,
    peerConnectionTimeout: input.peerConnectionTimeoutMs,
    ...(rtcConfig ? { rtcConfig } : {}),
  };
}
