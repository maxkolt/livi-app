/**
 * Тайминги и feature-флаги прямого (1:1) звонка.
 *
 * Вынесено из VideoCallSession.ts без изменения значений: модуль даёт одну точку правды
 * для таймеров/грейсов, которые раньше были разбросаны по шапке 9-тысячного файла.
 */

export const LIVEKIT_URL = ((process.env.EXPO_PUBLIC_LIVEKIT_URL as string | undefined) ?? '').trim();

// During camera flip / track replacement LiveKit can briefly unpublish/unsubscribe video.
// We should not treat that as "partner turned camera off" (otherwise UI flashes "Отошел").
// Slightly longer to cover renegotiation bursts during camera flip/restart on Android.
export const REMOTE_CAM_OFF_GRACE_MS = 1400;
// Remote participant can briefly disappear during LiveKit renegotiation/reconnect.
// Keep this guard short: a long window makes real remote hangup wait for delayed socket call:ended.
export const RECENT_RECONNECT_DISCONNECT_GUARD_MS = 2000;
export const REMOTE_PARTICIPANT_DISCONNECT_CONFIRM_MS = 250;
export const REMOTE_MEDIA_WATCHDOG_MS = 12_000;
export const REMOTE_MEDIA_SUBSCRIBE_RETRY_MS = 5_000;

/**
 * Client media restore window after unexpected disconnect / network drop.
 * Server CALL_LEASE_RECONNECTING_TTL_MS is longer so lease does not race this grace
 * while the peer (or restored socket) can still heartbeat.
 */
export const MEDIA_RECONNECT_GRACE_MS = 45_000;
/** Короткие socket flap не мигают «Восстановление…». */
export const PEER_RECONNECTING_UI_DEBOUNCE_MS = 250;
/** Survivor: remote audio track ended/missing after call was live → arm peer UI without SFU wait. */
export const REMOTE_AUDIO_SILENCE_UI_MS = 1_800;
/**
 * Survivor: inbound RTP stalled (airplane: track often stays readyState=live).
 * Arm «Слабая сеть» only when audio AND video RTP stay flat this long — audio-only
 * flat getStats on good Wi‑Fi (PiP / route / BT) must not flash the UI.
 */
export const REMOTE_MEDIA_PACKET_STALL_MS = 6_000;
export const REMOTE_AUDIO_PACKET_POLL_MS = 700;

/** `1|true|yes|on` → true, пустая строка → fallback. Любое другое значение → false. */
export function parsePublicFlag(value: string | undefined, fallback: boolean): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Safe defaults for 1:1 mobile calls:
// - dynacast ON gives bandwidth/CPU savings with low behavior risk.
// - adaptiveStream OFF by default; can be enabled via env after soak testing.
/** Окно дедупа call:accepted: одно событие приезжает сокетом, пушем и после reauth. */
export const CALL_ACCEPTED_DEDUP_MS = 60_000;

/**
 * Подключение к комнате после call:accepted: три попытки с нарастающей паузой
 * (500 / 1000 мс) — этого хватает, чтобы пережить короткий провал мобильной сети.
 */
export const ACCEPTED_ROOM_CONNECT_MAX_RETRIES = 3;
export const ACCEPTED_ROOM_CONNECT_RETRY_DELAY_MS = 500;

/**
 * Сколько ждём, пока SDK сам достроит комнату после неудачного connect-промиса,
 * прежде чем признать попытку провальной: 120 тиков по 100 мс = 12 с.
 */
export const SDK_RECONNECT_POLL_MS = 100;
export const SDK_RECONNECT_ADOPT_TICKS = 120;

/**
 * Дефолтные ~15s у LiveKit часто рвут соединение до готовности TURN/TCP: когда оба
 * участника подключаются одновременно, переговоры не успевают и падают с
 * «negotiation timed out».
 */
export const LIVEKIT_PEER_CONNECTION_TIMEOUT_MS = 30_000;

/**
 * Передавать ли в room.connect() клиентский ICE/TURN-конфиг с /api/turn-credentials.
 * Kill-switch на случай, если свой TURN окажется хуже серверного: EXPO_PUBLIC_LIVEKIT_APPLY_CLIENT_ICE=0.
 */
export const LIVEKIT_APPLY_CLIENT_ICE = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_APPLY_CLIENT_ICE, true);

export const LIVEKIT_ADAPTIVE_STREAM_ENABLED = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_ADAPTIVE_STREAM, false);
export const LIVEKIT_DYNACAST_ENABLED = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_DYNACAST, true);
