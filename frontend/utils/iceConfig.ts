// frontend/utils/iceConfig.ts
import { Platform } from 'react-native';
import { API_BASE } from '../sockets/socket';
import { getInstallId } from './installId';

let cachedConfig: RTCConfiguration | null = null;
let cacheUntil = 0;
const RELAY_FALLBACK_WINDOW_MS = 10 * 60 * 1000; // 10 минут принудительного relay после сетевых сбоев
let forcedRelayUntil = 0;

export function getEnvFallbackConfiguration(options?: { forceRelayOnly?: boolean }): RTCConfiguration {
  const forceRelayOnly = !!options?.forceRelayOnly;
  const googleStun = { urls: 'stun:stun.l.google.com:19302' } as any;
  const cloudflareStun = { urls: 'stun:stun.cloudflare.com:3478' } as any;
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
  const iceServers: any[] = [];
  
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
  } as any;
}

export async function getIceConfiguration(forceRefresh = false, options?: { forceRelayOnly?: boolean }): Promise<RTCConfiguration> {
  const forceRelayOnly = !!options?.forceRelayOnly;
  const relayActive = forceRelayOnly || (forcedRelayUntil > Date.now());
  const now = Date.now();
  if (!forceRefresh && cachedConfig && now < cacheUntil) return cachedConfig;

  // Таймауты: первая попытка 5s (VPN может быть медленнее), вторая 10s для надёжности
  const maxRetries = 2;
  const timeoutPerAttempt = [5000, 10000];
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const timeoutMs = timeoutPerAttempt[attempt - 1] ?? 5000;
    try {
      // Используем AbortController для таймаута
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const installId = await getInstallId().catch(() => '');
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (installId) headers['x-install-id'] = String(installId);

      const r = await fetch(`${API_BASE}/api/turn-credentials`, { 
        method: 'GET',
        signal: controller.signal,
        headers,
        // Дополнительные опции для VPN
        cache: 'no-cache',
      } as any);

      clearTimeout(timeoutId);

      if (r.ok) {
        const j = await r.json();
        if (j?.ok && Array.isArray(j.iceServers)) {
          // ВАЖНО: выкидываем TURN-серверы без кредов. Иначе ICE может "висеть" и выглядеть как бесконечный поиск.
          const cleanedIceServers = j.iceServers.filter((s: any) => {
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
          const hasTurn = cleanedIceServers.some((server: any) => 
            server.urls && (
              (Array.isArray(server.urls) && server.urls.some((u: string) => u.startsWith('turn:'))) ||
              (typeof server.urls === 'string' && server.urls.startsWith('turn:'))
            )
          );
          
          console.log('[ICE Config] Server configuration loaded:', {
            serverCount: cleanedIceServers.length,
            hasTurn,
            hasCredentials: cleanedIceServers.some((s: any) => s.username && s.credential),
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
          
          const cfg: RTCConfiguration = {
            iceServers: cleanedIceServers,
            iceTransportPolicy: finalIceTransportPolicy,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            // ОПТИМИЗИРОВАНО: Уменьшены параметры для более быстрого подключения
            iceCandidatePoolSize: 0, // Отключаем предварительный сбор кандидатов для ускорения
            iceGatheringTimeout: 5000, // Уменьшено с 10s до 5s для быстрого подключения
          } as any;
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
    } catch (error: any) {
      lastError = error;
      const isAborted = error?.name === 'AbortError' || error?.message?.includes('aborted');
      const isNetworkError = error?.message?.includes('Network request failed') || error?.message?.includes('Failed to fetch');
      
      if (attempt < maxRetries) {
        // ОПТИМИЗИРОВАНО: Уменьшена задержка между попытками для быстрого fallback
        const delay = 500 * attempt; // Уменьшено с 1000-2000ms до 500ms
        console.warn(`[ICE Config] Fetch failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`, 
          isAborted ? 'timeout' : isNetworkError ? 'network error (VPN may be blocking)' : error?.message || error);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      } else {
        const vpnWarning = Platform.OS === 'ios' && isNetworkError 
          ? '⚠️ VPN may be blocking network requests. Try disabling VPN or use relay-only mode.' 
          : undefined;
        console.warn('[ICE Config] Failed to fetch server config after all retries, using fallback:', 
          isAborted ? 'timeout' : isNetworkError ? 'network error' : error?.message || error,
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
      lastError?.message?.includes('Network request failed') ||
      lastError?.message?.includes('Failed to fetch') ||
      lastError?.name === 'AbortError';
    if (isNetworkIssue) {
      const hasTurn = (fallbackConfig.iceServers as any[])?.some?.((s: any) => {
        const u = s?.urls;
        const list = Array.isArray(u) ? u : (typeof u === 'string' ? [u] : []);
        return list.some((url: string) => typeof url === 'string' && url.startsWith('turn:'));
      });
      if (hasTurn) {
        (fallbackConfig as any).iceTransportPolicy = 'relay';
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
