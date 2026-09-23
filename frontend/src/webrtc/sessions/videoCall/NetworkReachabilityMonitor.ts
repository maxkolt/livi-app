/**
 * Подписка на NetInfo на время звонка: переход true→false — «связь пропала»,
 * false→true — «связь вернулась, пора перезайти в комнату».
 *
 * Вынесено из VideoCallSession: класс держит только подписку и прошлое состояние
 * достижимости, а решения (показать «Восстановление…», перезайти в LiveKit)
 * остаются за сессией через host-порты.
 */

import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { logger } from '../../../../utils/logger';
import { isNetInfoReachable } from './mediaStats';

export type NetworkReachabilityHost = {
  /** false → звонок завершается, события игнорируем. */
  isCallActive: () => boolean;
  /** Есть ли LiveKit-креды, чтобы перезайти; без них реагировать не на что. */
  hasLiveKitCredsForRejoin: () => boolean;
  onLinkLost: () => void;
  onLinkRestored: () => void;
};

export class NetworkReachabilityMonitor {
  private unsubscribe: (() => void) | null = null;
  private lastReachable: boolean | null = null;

  constructor(private readonly host: NetworkReachabilityHost) {}

  isRunning(): boolean {
    return this.unsubscribe != null;
  }

  start(): void {
    if (this.unsubscribe || !this.host.isCallActive()) return;
    try {
      this.unsubscribe = NetInfo.addEventListener((state) => {
        this.handleState(state);
      });
      void NetInfo.fetch()
        .then((state) => {
          if (!this.host.isCallActive()) return;
          // Seed without acting on the first snapshot (same as socket NetInfo).
          this.lastReachable = isNetInfoReachable(state);
        })
        .catch(() => {});
    } catch (e) {
      logger.warn('[VideoCallSession] NetInfo monitor failed to start', e);
    }
  }

  stop(): void {
    try {
      this.unsubscribe?.();
    } catch {}
    this.unsubscribe = null;
    this.lastReachable = null;
  }

  /** Внутренний обработчик; открыт для тестов, чтобы не поднимать NetInfo. */
  handleState(state: NetInfoState): void {
    if (!this.host.isCallActive()) return;
    const reachable = isNetInfoReachable(state);
    const wasReachable = this.lastReachable;
    this.lastReachable = reachable;

    if (!this.host.hasLiveKitCredsForRejoin()) return;

    // true → false: airplane / Wi‑Fi drop — show restoring immediately (don't wait for LiveKit Disconnected).
    if (!reachable && wasReachable === true) {
      this.host.onLinkLost();
      return;
    }
    // false → true: network back — force LiveKit re-join (socket NetInfo alone is not enough).
    if (reachable && wasReachable === false) {
      this.host.onLinkRestored();
    }
  }
}
