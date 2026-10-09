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
/**
 * Смена сети при живой комнате (VPN on/off, Wi‑Fi↔LTE): LiveKit сам делает resume с
 * ICE restart и теми же треками. Свой полный re-join — только если он не справился за это время.
 */
export const LIVEKIT_SELF_RECOVERY_WAIT_MS = 12_000;
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
/**
 * Видео партнёра стоит, хотя мы его ждём, а комната «connected»: после смены сети (VPN off)
 * приём оставался на мёртвом пути ~20 с, пока SFU сам не присылал leave-reconnect. Столько
 * ждём и просим LiveKit resume (ICE restart) сами.
 */
export const REMOTE_VIDEO_STALL_RESUME_MS = 4_000;
/** Такой resume — не чаще и не больше нескольких за звонок: у партнёра может быть своя беда. */
export const REMOTE_VIDEO_STALL_RESUME_COOLDOWN_MS = 20_000;
export const REMOTE_VIDEO_STALL_RESUME_MAX = 3;
/** Партнёр сам сообщил о потере сети — наш resume ему не поможет. */
export const PEER_NETWORK_DOWN_RESUME_SKIP_MS = 15_000;
/** livekit.ReconnectReason.RR_SUBSCRIBER_FAILED — сам enum livekit-client не экспортирует. */
export const LIVEKIT_RR_SUBSCRIBER_FAILED = 3;

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
 * Отдельный таймаут signaling WebSocket. Заблокированный VPN домен не должен держать
 * экран принятого звонка 30 секунд: после этого окна пробуем proxy через API-домен.
 *
 * Срок держит наш watchdog (./signalWatchdog), а не SDK: livekit-client 2.16 на «чёрной
 * дыре» снимает свой таймер, когда Android рвёт сокет (~10 с), и уходит в HTTP
 * /rtc/validate без таймаута — connect висел больше минуты (тест 2026-10-01).
 */
export const LIVEKIT_WEBSOCKET_TIMEOUT_MS = 8_000;

/**
 * Основной signaling через API-домен: он уже обязан быть доступен для call:accept,
 * сообщений и TURN credentials, тогда как отдельный livekit-домен часть VPN глушит.
 * Медиа через API не идёт — только короткие управляющие WebSocket-сообщения.
 */
export const LIVEKIT_PREFER_SIGNAL_PROXY = parsePublicFlag(
  process.env.EXPO_PUBLIC_LIVEKIT_PREFER_SIGNAL_PROXY,
  true,
);

/** Брошенная попытка connect: дольше не ждём room.disconnect(), SDK мог зависнуть. */
export const FAILED_ROOM_DISCONNECT_WAIT_MS = 1_500;

/**
 * Только dev-сборка: имитация VPN, который молча глушит домен LiveKit. Прямой signaling
 * уходит в TEST-NET-1 (никуда не маршрутизируется), и звонок обязан через
 * LIVEKIT_WEBSOCKET_TIMEOUT_MS уйти в /livekit proxy. Включение:
 * EXPO_PUBLIC_LIVEKIT_TEST_BLOCK_DIRECT=1 + перезапуск Metro.
 */
export const LIVEKIT_TEST_BLOCK_DIRECT_SIGNAL =
  __DEV__ && parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_TEST_BLOCK_DIRECT, false);
export const LIVEKIT_TEST_BLACKHOLE_URL = 'wss://192.0.2.1';

/**
 * Передавать ли в room.connect() клиентский ICE/TURN-конфиг с /api/turn-credentials.
 * Kill-switch на случай, если свой TURN окажется хуже серверного: EXPO_PUBLIC_LIVEKIT_APPLY_CLIENT_ICE=0.
 */
export const LIVEKIT_APPLY_CLIENT_ICE = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_APPLY_CLIENT_ICE, true);

export const LIVEKIT_ADAPTIVE_STREAM_ENABLED = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_ADAPTIVE_STREAM, false);
export const LIVEKIT_DYNACAST_ENABLED = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_DYNACAST, true);
