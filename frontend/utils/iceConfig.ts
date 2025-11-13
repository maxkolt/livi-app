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
  const iceServers: any[] = [googleStun, cloudflareStun];
  if (turnUrls.length) iceServers.push({ urls: turnUrls, username, credential });
  if (turnTcpUrls.length) iceServers.push({ urls: turnTcpUrls, username, credential });

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
      }
    }
  } catch (error) {
    console.warn('[ICE Config] Failed to fetch server config, using fallback:', error);
  }

  cachedConfig = getEnvFallbackConfiguration();
  cacheUntil = now + 5 * 60 * 1000;
  return cachedConfig;
}
