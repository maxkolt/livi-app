// frontend/utils/iceConfig.ts
import { Platform } from 'react-native';
import { API_BASE } from '../sockets/socket';
import { getInstallAuthHeaders } from './installId';

/** Existing app configuration, including the legacy timeout field. */
type CallRTCConfiguration = RTCConfiguration & { iceGatheringTimeout?: number };

type TurnCredentialsResponse = {
  ok?: boolean;
  iceServers?: RTCIceServer[];
  ttl?: number | string | null;
};

let cachedConfig: CallRTCConfiguration | null = null;
let cacheUntil = 0;
const RELAY_FALLBACK_WINDOW_MS = 10 * 60 * 1000; // 10 минут принудительного relay после сетевых сбоев
let forcedRelayUntil = 0;

function iceConfigHasTurn(cfg: CallRTCConfiguration | null | undefined): boolean {
  const servers = (cfg)?.iceServers;
  if (!Array.isArray(servers)) return false;
  return servers.some((s) => {
    const u = s?.urls;
    const list = Array.isArray(u) ? u : typeof u === 'string' ? [u] : [];
    return list.some((url: string) => typeof url === 'string' && url.startsWith('turn:'));
  });
}

/** Clone cfg and force iceTransportPolicy=relay when TURN is present. */
function withRelayOnlyPolicy(cfg: CallRTCConfiguration): CallRTCConfiguration {
  if (!iceConfigHasTurn(cfg)) return cfg;
  return {
    ...(cfg),
    iceTransportPolicy: 'relay',
  } as CallRTCConfiguration;
}

/**
 * После сбоя PeerConnection (типично VPN / жёсткий NAT) — на окно времени
 * все следующие getIceConfiguration() отдают relay-only.
 */
export function enableForcedRelayFallback(reason?: string): void {
  forcedRelayUntil = Date.now() + RELAY_FALLBACK_WINDOW_MS;
  console.warn(
    `[ICE Config] Forced relay-only for ${Math.round(RELAY_FALLBACK_WINDOW_MS / 60000)}m` +
      (reason ? ` (${reason})` : ''),
  );
}

function getEnvFallbackConfiguration(options?: { forceRelayOnly?: boolean }): CallRTCConfiguration {
  const forceRelayOnly = !!options?.forceRelayOnly;
  const googleStun = { urls: 'stun:stun.l.google.com:19302' };
  const cloudflareStun = { urls: 'stun:stun.cloudflare.com:3478' };
  const rawTurn = (process.env.EXPO_PUBLIC_TURN_URLS || process.env.EXPO_PUBLIC_TURN_URL || '').trim();
  const rawTurnTcp = (process.env.EXPO_PUBLIC_TURN_TCP_URLS || '').trim();
  const username = process.env.EXPO_PUBLIC_TURN_USERNAME || '';
  const credential = process.env.EXPO_PUBLIC_TURN_CREDENTIAL || '';
  const icePolicyEnv = (process.env.EXPO_PUBLIC_ICE_POLICY || '').trim().toLowerCase();
  const hasTurnCredentials = !!(username && credential);

  let turnUrls: string[] = rawTurn ? rawTurn.split(/[\,\s]+/).filter(Boolean) : [];
  let turnTcpUrls: string[] = rawTurnTcp ? rawTurnTcp.split(/[\,\s]+/).filter(Boolean) : [];
  
  // КРИТИЧНО: Фильтруем placeholder значения (yourdomain, localhost и т.д.)
  turnUrls = turnUrls.filter(url => {
    const isValid = !url.includes('yourdomain') && 
                    !url.includes('localhost') && 
                    !url.includes('127.0.0.1') &&
                    !url.includes('example.com');
    if (!isValid) {
      console.warn('[ICE Config] Игнорируем placeholder TURN URL:', url);
    }
    return isValid;
  });
  
  // КРИТИЧНО: Если TURN URL не задан в env или только placeholders, извлекаем из API_BASE
  // Это важно для fallback при VPN блокировке
  // ВАЖНО: не добавляем TURN без кредов — это приводит к долгому ICE и "залипанию" в поиске.
  if (hasTurnCredentials && turnUrls.length === 0 && API_BASE) {
    try {
      // Извлекаем хост из API_BASE (например, http://89.111.152.241:3000 -> 89.111.152.241)
      const urlMatch = API_BASE.match(/https?:\/\/([^:\/]+)/);
      if (urlMatch && urlMatch[1]) {
        const host = urlMatch[1];
        // Используем стандартный порт TURN (3478)
        const defaultTurnUrl = `turn:${host}:3478`;
        const defaultTurnTcpUrl = `turn:${host}:3478?transport=tcp`;
        
        // Проверяем, что это не placeholder
        if (!host.includes('yourdomain') && !host.includes('localhost') && !host.includes('127.0.0.1')) {
          turnUrls.push(defaultTurnUrl);
          // Добавляем TCP TURN для обхода проблем VPN с UDP
          turnTcpUrls.push(defaultTurnTcpUrl);
          console.log('[ICE Config] Using TURN server from API_BASE:', { host, turnUrl: defaultTurnUrl, turnTcpUrl: defaultTurnTcpUrl });
        }
      }
    } catch (e) {
      console.warn('[ICE Config] Failed to extract TURN from API_BASE:', e);
    }
  }

  // ОПТИМИЗИРОВАНО: Приоритет TURN серверам для более быстрого подключения
  // TURN серверы идут ПЕРВЫМИ, так как они обеспечивают надежное соединение
  const iceServers: RTCIceServer[] = [];
  
  // КРИТИЧНО: TURN обязателен для пробития NAT в мобильных сетях
  // Размещаем TURN серверы ПЕРВЫМИ для приоритета при ICE gathering
  if (hasTurnCredentials && turnUrls.length) {
    // Каждый TURN URL должен быть отдельным объектом
    turnUrls.forEach(url => {
      iceServers.push({ urls: url, username, credential });
    });
  }
  if (hasTurnCredentials && turnTcpUrls.length) {
    turnTcpUrls.forEach(url => {
      iceServers.push({ urls: url, username, credential });
    });
  }
  
  // STUN серверы идут ПОСЛЕ TURN для резервирования
  // Используем только основные STUN серверы для уменьшения времени подключения
  iceServers.push(googleStun);
  iceServers.push(cloudflareStun);
  // Убраны дополнительные STUN серверы для ускорения подключения

  // Логирование для отладки
  const hasTurn = turnUrls.length > 0 || turnTcpUrls.length > 0;
  console.log('[ICE Config] Fallback configuration:', {
    stunCount: 2,
    turnCount: turnUrls.length + turnTcpUrls.length,
    hasTurn,
    hasCredentials: hasTurnCredentials,
    turnUrls: turnUrls.length > 0 ? turnUrls : undefined,
    turnTcpUrls: turnTcpUrls.length > 0 ? turnTcpUrls : undefined,
    warning: !hasTurnCredentials
      ? '⚠️ TURN credentials are missing — TURN will be disabled in fallback (STUN-only).'
      : !hasTurn
        ? '⚠️ NO TURN SERVER - NAT traversal may fail!'
        : undefined,
  });

  const envRelayOnly = icePolicyEnv === 'relay' || icePolicyEnv === 'relay-only' || process.env.EXPO_PUBLIC_ICE_RELAY_ONLY === '1';
  const shouldForceRelay = envRelayOnly || forceRelayOnly;
  
  // КРИТИЧНО: Если нет TURN сервера, НЕ используем relay-only режим
  // Relay-only требует TURN сервер, иначе RTCPeerConnection не инициализируется
  const finalIceTransportPolicy = (shouldForceRelay && hasTurn) ? 'relay' : 'all';
  
  if (shouldForceRelay && !hasTurn) {
    console.warn('[ICE Config] ⚠️ relay-only режим запрошен, но TURN сервер отсутствует. Используем "all" режим.');
  } else if (forceRelayOnly && hasTurn) {
    console.log('[ICE Config] Relay-only fallback принудительно включен (TURN доступен).');
  }
  
  return {
    iceServers,
    iceTransportPolicy: finalIceTransportPolicy,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    // ОПТИМИЗИРОВАНО: Уменьшены параметры для более быстрого подключения
    iceCandidatePoolSize: 0, // Отключаем предварительный сбор кандидатов для ускорения
    iceGatheringTimeout: 5000, // Уменьшено с 10s до 5s для быстрого подключения
  } satisfies CallRTCConfiguration;
}

/**
 * Через VPN новое соединение к API иногда виснет 8–30 с, а соседнее открывается сразу.
 * Если ответа нет ICE_FETCH_HEDGE_DELAY_MS, шлём второй такой же запрос и берём первый ответ.
 */
const ICE_FETCH_HEDGE_DELAY_MS = 1500;

function fetchWithHedge(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let failed = 0;
    let lastError: unknown = null;
    const finish = () => {
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadline);
    };
    const launch = () => {
      const controller = new AbortController();
      controllers.push(controller);
      fetch(url, { ...init, signal: controller.signal }).then(
        (response) => {
          if (settled) return;
          finish();
          // Проигравший запрос отменяем; у победителя тело ещё читается — его не трогаем.
          controllers.forEach((c) => c !== controller && c.abort());
          resolve(response);
        },
        (error) => {
          if (settled) return;
          failed += 1;
          lastError = error;
          if (controllers.length < 2) {
            clearTimeout(hedgeTimer);
            launch();
          } else if (failed >= controllers.length) {
            finish();
            reject(lastError);
          }
        },
      );
    };
    const hedgeTimer = setTimeout(() => {
      if (!settled && controllers.length < 2) launch();
    }, ICE_FETCH_HEDGE_DELAY_MS);
    const deadline = setTimeout(() => {
      if (settled) return;
      finish();
      controllers.forEach((c) => c.abort());
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
    launch();
  });
}

let iceFetchInFlight: Promise<CallRTCConfiguration> | null = null;

export async function getIceConfiguration(forceRefresh = false, options?: { forceRelayOnly?: boolean }): Promise<CallRTCConfiguration> {
  const forceRelayOnly = !!options?.forceRelayOnly;
  const relayActive = forceRelayOnly || (forcedRelayUntil > Date.now());
  const now = Date.now();
  // КРИТИЧНО: даже из кэша применяем relay-only (VPN retry), иначе policy остаётся "all".
  if (!forceRefresh && cachedConfig && now < cacheUntil) {
    return relayActive ? withRelayOnlyPolicy(cachedConfig) : cachedConfig;
  }
  // Предзагрузка и подключение часто совпадают по времени — второй ждёт тот же запрос.
  if (!forceRefresh && iceFetchInFlight) {
    const cfg = await iceFetchInFlight;
    return relayActive ? withRelayOnlyPolicy(cfg) : cfg;
  }
  const request = fetchIceConfiguration(forceRelayOnly, relayActive, now);
  if (!forceRefresh) {
    iceFetchInFlight = request;
    request.finally(() => {
      if (iceFetchInFlight === request) iceFetchInFlight = null;
    }).catch(() => {});
  }
  return request;
}

/** Начать загрузку ICE заранее (экран рандом-чата, входящий звонок): к подключению она уже в кэше. */
export function prefetchIceConfiguration(): void {
  void getIceConfiguration(false).catch(() => {});
}

async function fetchIceConfiguration(
  forceRelayOnly: boolean,
  relayActive: boolean,
  now: number,
): Promise<CallRTCConfiguration> {
  // Таймауты: первая попытка 8s (VPN / медленный DNS), вторая 15s для надёжности
  const maxRetries = 2;
  const timeoutPerAttempt = [8000, 15000];
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const timeoutMs = timeoutPerAttempt[attempt - 1] ?? 5000;
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        ...(await getInstallAuthHeaders()),
      };

      const r = await fetchWithHedge(
        `${API_BASE}/api/turn-credentials`,
        {
          method: 'GET',
          headers,
          // Дополнительные опции для VPN
          cache: 'no-cache',
        },
        timeoutMs,
      );

      if (r.ok) {
        const j: TurnCredentialsResponse | null = await r.json();
        if (j?.ok && Array.isArray(j.iceServers)) {
          // ВАЖНО: выкидываем TURN-серверы без кредов. Иначе ICE может "висеть" и выглядеть как бесконечный поиск.
          const cleanedIceServers = j.iceServers.filter((s) => {
            const urls = s?.urls;
            const list: string[] = Array.isArray(urls) ? urls : (typeof urls === 'string' ? [urls] : []);
            const hasTurnUrl = list.some((u) => typeof u === 'string' && u.startsWith('turn:'));
            if (!hasTurnUrl) return true; // STUN/прочее оставляем
            const okCreds = !!(s?.username && s?.credential);
            if (!okCreds) {
              console.warn('[ICE Config] Dropping TURN server without credentials:', { urls: list });
            }
            return okCreds;
          });

          // Проверяем наличие TURN серверов
          const hasTurn = cleanedIceServers.some((server) =>
            server.urls && (
              (Array.isArray(server.urls) && server.urls.some((u: string) => u.startsWith('turn:'))) ||
              (typeof server.urls === 'string' && server.urls.startsWith('turn:'))
            )
          );
          
          console.log('[ICE Config] Server configuration loaded:', {
            serverCount: cleanedIceServers.length,
            hasTurn,
            hasCredentials: cleanedIceServers.some((s) => s.username && s.credential),
            ttl: j.ttl,
            attempt,
            platform: Platform.OS,
            warning: !hasTurn ? '⚠️ NO TURN SERVER from server - NAT traversal may fail!' : undefined,
          });

          const relayOnlyEnv = (process.env.EXPO_PUBLIC_ICE_POLICY || '').trim().toLowerCase();
          const relayOnly = relayOnlyEnv === 'relay' || relayOnlyEnv === 'relay-only' || process.env.EXPO_PUBLIC_ICE_RELAY_ONLY === '1';
          
          // КРИТИЧНО: Если нет TURN сервера, НЕ используем relay-only режим
          const finalIceTransportPolicy = ((relayOnly || forceRelayOnly || relayActive) && hasTurn) ? 'relay' : 'all';
          
          if (relayOnly && !hasTurn) {
            console.warn('[ICE Config] ⚠️ relay-only режим запрошен, но TURN сервер отсутствует в ответе сервера. Используем "all" режим.');
          }
          
          const cfg: CallRTCConfiguration = {
            iceServers: cleanedIceServers,
            iceTransportPolicy: finalIceTransportPolicy,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            // ОПТИМИЗИРОВАНО: Уменьшены параметры для более быстрого подключения
            iceCandidatePoolSize: 0, // Отключаем предварительный сбор кандидатов для ускорения
            iceGatheringTimeout: 5000, // Уменьшено с 10s до 5s для быстрого подключения
          } satisfies CallRTCConfiguration;
          cachedConfig = cfg;
          const ttlSec = Math.max(60, Math.min(Number(j.ttl || 300), 3600));
          cacheUntil = now + Math.floor(ttlSec * 900); // 90% of ttl in ms
          return cfg;
        } else {
          console.warn('[ICE Config] Invalid server response format:', j);
        }
      } else {
        console.warn(`[ICE Config] Server returned error (attempt ${attempt}/${maxRetries}):`, r.status, r.statusText);
        lastError = new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
    } catch (error) {
      lastError = error;
      const isAborted = (error as Error | null | undefined)?.name === 'AbortError' || (error as Error | null | undefined)?.message?.includes('aborted');
      const isNetworkError = (error as Error | null | undefined)?.message?.includes('Network request failed') || (error as Error | null | undefined)?.message?.includes('Failed to fetch');
      
      if (attempt < maxRetries) {
        // ОПТИМИЗИРОВАНО: Уменьшена задержка между попытками для быстрого fallback
        const delay = 500 * attempt; // Уменьшено с 1000-2000ms до 500ms
        console.warn(`[ICE Config] Fetch failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`, 
          isAborted ? 'timeout' : isNetworkError ? 'network error (VPN may be blocking)' : (error as Error | null | undefined)?.message || error);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      } else {
        const vpnWarning = Platform.OS === 'ios' && isNetworkError 
          ? '⚠️ VPN may be blocking network requests. Try disabling VPN or use relay-only mode.' 
          : undefined;
        console.warn('[ICE Config] Failed to fetch server config after all retries, using fallback:', 
          isAborted ? 'timeout' : isNetworkError ? 'network error' : (error as Error | null | undefined)?.message || error,
          vpnWarning);
      }
      if (isNetworkError) {
        forcedRelayUntil = Date.now() + RELAY_FALLBACK_WINDOW_MS;
        console.warn('[ICE Config] Enabling relay-only fallback for the next 10 minutes due to network errors');
      }
    }
  }

  // Используем fallback конфигурацию
  // При медленной сети / VPN: таймаут fetch кредов или обрыв TCP — relay-only через TURN
  // стабильнее прямого P2P (одинаково на iOS и Android).
  const fallbackConfig = getEnvFallbackConfiguration({ forceRelayOnly: forceRelayOnly || relayActive });

  if (lastError) {
    const isNetworkIssue =
      (lastError as Error | null | undefined)?.message?.includes('Network request failed') ||
      (lastError as Error | null | undefined)?.message?.includes('Failed to fetch') ||
      (lastError as Error | null | undefined)?.name === 'AbortError';
    if (isNetworkIssue) {
      const hasTurn = (fallbackConfig.iceServers)?.some?.((s) => {
        const u = s?.urls;
        const list = Array.isArray(u) ? u : (typeof u === 'string' ? [u] : []);
        return list.some((url: string) => typeof url === 'string' && url.startsWith('turn:'));
      });
      if (hasTurn) {
        (fallbackConfig).iceTransportPolicy = 'relay';
        console.warn(
          `[ICE Config] ${Platform.OS} + network/timeout after TURN fetch failure: relay-only for VPN / bad path compatibility.`,
        );
      }
    }
  }
  
  cachedConfig = fallbackConfig;
  cacheUntil = now + 5 * 60 * 1000;
  return cachedConfig;
}
