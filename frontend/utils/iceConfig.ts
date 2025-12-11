// frontend/utils/iceConfig.ts
import { Platform } from 'react-native';
import { API_BASE } from '../sockets/socket';

let cachedConfig: RTCConfiguration | null = null;
let cacheUntil = 0;

export function getEnvFallbackConfiguration(): RTCConfiguration {
  const googleStun = { urls: 'stun:stun.l.google.com:19302' } as any;
  const cloudflareStun = { urls: 'stun:stun.cloudflare.com:3478' } as any;
  const rawTurn = (process.env.EXPO_PUBLIC_TURN_URLS || process.env.EXPO_PUBLIC_TURN_URL || '').trim();
  const rawTurnTcp = (process.env.EXPO_PUBLIC_TURN_TCP_URLS || '').trim();
  const username = process.env.EXPO_PUBLIC_TURN_USERNAME || '';
  const credential = process.env.EXPO_PUBLIC_TURN_CREDENTIAL || '';
  const icePolicyEnv = (process.env.EXPO_PUBLIC_ICE_POLICY || '').trim().toLowerCase();

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
  if (turnUrls.length === 0 && API_BASE) {
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

  // Используем несколько STUN серверов для лучшей надежности
  const iceServers: any[] = [
    googleStun,
    cloudflareStun,
    { urls: 'stun:stun.stunprotocol.org:3478' } as any,
    { urls: 'stun:stun.voiparound.com' } as any,
    { urls: 'stun:stun.voipbuster.com' } as any,
  ];
  
  // КРИТИЧНО: TURN обязателен для пробития NAT в мобильных сетях
  if (turnUrls.length) {
    // Каждый TURN URL должен быть отдельным объектом
    turnUrls.forEach(url => {
      iceServers.push({ urls: url, username, credential });
    });
  }
  if (turnTcpUrls.length) {
    turnTcpUrls.forEach(url => {
      iceServers.push({ urls: url, username, credential });
    });
  }

  // Логирование для отладки
  const hasTurn = turnUrls.length > 0 || turnTcpUrls.length > 0;
  console.log('[ICE Config] Fallback configuration:', {
    stunCount: 5,
    turnCount: turnUrls.length + turnTcpUrls.length,
    hasTurn,
    hasCredentials: !!(username && credential),
    turnUrls: turnUrls.length > 0 ? turnUrls : undefined,
    turnTcpUrls: turnTcpUrls.length > 0 ? turnTcpUrls : undefined,
    warning: !hasTurn ? '⚠️ NO TURN SERVER - NAT traversal may fail!' : undefined,
  });

  const relayOnly = icePolicyEnv === 'relay' || icePolicyEnv === 'relay-only' || process.env.EXPO_PUBLIC_ICE_RELAY_ONLY === '1';
  
  // КРИТИЧНО: Если нет TURN сервера, НЕ используем relay-only режим
  // Relay-only требует TURN сервер, иначе RTCPeerConnection не инициализируется
  // hasTurn уже объявлен выше (строка 68)
  const finalIceTransportPolicy = (relayOnly && hasTurn) ? 'relay' : 'all';
  
  if (relayOnly && !hasTurn) {
    console.warn('[ICE Config] ⚠️ relay-only режим запрошен, но TURN сервер отсутствует. Используем "all" режим.');
  }
  
  return {
    iceServers,
    iceTransportPolicy: finalIceTransportPolicy,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    // Дополнительные оптимизации для мобильных устройств
    iceCandidatePoolSize: 10,
    iceGatheringTimeout: 10000,
  } as any;
}

export async function getIceConfiguration(forceRefresh = false): Promise<RTCConfiguration> {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && now < cacheUntil) return cachedConfig;

  // Retry логика для iOS (где fetch может падать, особенно с VPN)
  // Увеличиваем количество попыток и таймаут при VPN
  const maxRetries = Platform.OS === 'ios' ? 5 : 3; // Больше попыток для iOS (VPN может блокировать)
  const timeoutMs = Platform.OS === 'ios' ? 15000 : 8000; // Больше таймаут для iOS
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Используем AbortController для таймаута
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const r = await fetch(`${API_BASE}/api/turn-credentials`, { 
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
        // Дополнительные опции для VPN
        cache: 'no-cache',
      } as any);

      clearTimeout(timeoutId);

      if (r.ok) {
        const j = await r.json();
        if (j?.ok && Array.isArray(j.iceServers)) {
          // Проверяем наличие TURN серверов
          const hasTurn = j.iceServers.some((server: any) => 
            server.urls && (
              (Array.isArray(server.urls) && server.urls.some((u: string) => u.startsWith('turn:'))) ||
              (typeof server.urls === 'string' && server.urls.startsWith('turn:'))
            )
          );
          
          console.log('[ICE Config] Server configuration loaded:', {
            serverCount: j.iceServers.length,
            hasTurn,
            hasCredentials: j.iceServers.some((s: any) => s.username && s.credential),
            ttl: j.ttl,
            attempt,
            platform: Platform.OS,
            warning: !hasTurn ? '⚠️ NO TURN SERVER from server - NAT traversal may fail!' : undefined,
          });

          const relayOnlyEnv = (process.env.EXPO_PUBLIC_ICE_POLICY || '').trim().toLowerCase();
          const relayOnly = relayOnlyEnv === 'relay' || relayOnlyEnv === 'relay-only' || process.env.EXPO_PUBLIC_ICE_RELAY_ONLY === '1';
          
          // КРИТИЧНО: Если нет TURN сервера, НЕ используем relay-only режим
          const finalIceTransportPolicy = (relayOnly && hasTurn) ? 'relay' : 'all';
          
          if (relayOnly && !hasTurn) {
            console.warn('[ICE Config] ⚠️ relay-only режим запрошен, но TURN сервер отсутствует в ответе сервера. Используем "all" режим.');
          }
          
          const cfg: RTCConfiguration = {
            iceServers: j.iceServers,
            iceTransportPolicy: finalIceTransportPolicy,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            // Дополнительные оптимизации для мобильных устройств
            iceCandidatePoolSize: 10,
            iceGatheringTimeout: 10000,
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
        // Увеличиваем задержку с каждой попыткой (особенно для iOS/VPN)
        const baseDelay = Platform.OS === 'ios' ? 2000 : 1000;
        const delay = baseDelay * attempt;
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
    }
  }

  // Используем fallback конфигурацию
  // КРИТИЧНО: При VPN на iOS может быть полезно использовать relay-only режим
  // (только TURN, без прямых P2P соединений)
  const fallbackConfig = getEnvFallbackConfiguration();
  
  // Если на iOS и есть проблемы с сетью, принудительно используем relay-only
  // Это поможет обойти проблемы VPN с UDP трафиком
  if (Platform.OS === 'ios' && lastError) {
    const isNetworkIssue = lastError?.message?.includes('Network request failed') || 
                          lastError?.message?.includes('Failed to fetch') ||
                          lastError?.name === 'AbortError';
    
    if (isNetworkIssue) {
      console.warn('[ICE Config] ⚠️ Network issues detected on iOS. Consider using relay-only mode if VPN is active.');
      // Можно принудительно включить relay-only, но пока оставляем выбор пользователю
      // fallbackConfig.iceTransportPolicy = 'relay';
    }
  }
  
  cachedConfig = fallbackConfig;
  cacheUntil = now + 5 * 60 * 1000;
  return cachedConfig;
}
