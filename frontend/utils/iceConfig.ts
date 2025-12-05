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

  const turnUrls: string[] = rawTurn ? rawTurn.split(/[\,\s]+/).filter(Boolean) : [];
  const turnTcpUrls: string[] = rawTurnTcp ? rawTurnTcp.split(/[\,\s]+/).filter(Boolean) : [];

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
  return {
    iceServers,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
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

  try {
    const r = await fetch(`${API_BASE}/api/turn-credentials`, { 
      method: 'GET'
    });
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
          warning: !hasTurn ? '⚠️ NO TURN SERVER from server - NAT traversal may fail!' : undefined,
        });

        const relayOnlyEnv = (process.env.EXPO_PUBLIC_ICE_POLICY || '').trim().toLowerCase();
        const relayOnly = relayOnlyEnv === 'relay' || relayOnlyEnv === 'relay-only' || process.env.EXPO_PUBLIC_ICE_RELAY_ONLY === '1';
        const cfg: RTCConfiguration = {
          iceServers: j.iceServers,
          iceTransportPolicy: relayOnly ? 'relay' : 'all',
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
      console.warn('[ICE Config] Server returned error:', r.status, r.statusText);
    }
  } catch (error) {
    console.warn('[ICE Config] Failed to fetch server config, using fallback:', error);
  }

  cachedConfig = getEnvFallbackConfiguration();
  cacheUntil = now + 5 * 60 * 1000;
  return cachedConfig;
}
