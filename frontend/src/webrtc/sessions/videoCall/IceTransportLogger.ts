/**
 * Диагностика выбранного ICE-пути: пара отложенных снимков после connect/reconnect,
 * дедуп по сигнатуре, отмена таймеров при разрыве.
 *
 * Вынесено из VideoCallSession: два таймерных поля и три метода, которые к самому звонку
 * отношения не имеют — только к логам. Сессия даёт лишь «эта ли комната сейчас активна»
 * и подписи участников.
 */

import type { Room } from 'livekit-client';
import { logger } from '../../../../utils/logger';
import { getRoomIceTransportDiagnostics } from '../../iceTransportDiagnostics';
import { buildIceTransportSignature } from './mediaStats';

/** Снимки берём дважды: сразу после установления и после стабилизации ICE. */
const ICE_TRANSPORT_LOG_DELAYS_MS = [1500, 5000];

export type IceTransportLoggerHost = {
  /** false → комнату уже сменили/закрыли, лог не нужен. */
  isCurrentRoom: (room: Room) => boolean;
  /** Подписи участников для читаемости лога. */
  describeParticipants: () => { myUserId?: string | null; partnerUserId?: string | null };
};

export class IceTransportLogger {
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private lastSignature: string | null = null;

  constructor(private readonly host: IceTransportLoggerHost) {}

  /** Снять запланированные снимки (разрыв комнаты / teardown). Сигнатуру не сбрасываем. */
  clear(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  /** Новая комната/новое подключение: снять таймеры и разрешить залогировать путь заново. */
  reset(): void {
    this.clear();
    this.lastSignature = null;
  }

  schedule(room: Room, reason: string): void {
    for (const delayMs of ICE_TRANSPORT_LOG_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.timers = this.timers.filter((entry) => entry !== timer);
        void this.log(room, `${reason}:${delayMs}ms`);
      }, delayMs);
      this.timers.push(timer);
    }
  }

  async log(room: Room, reason: string): Promise<void> {
    try {
      if (!this.host.isCurrentRoom(room)) return;
      const diagnostics = await getRoomIceTransportDiagnostics(room as any);
      if (!diagnostics.length) {
        logger.debug('[VideoCallSession] ICE transport diagnostics unavailable', {
          reason,
          roomName: room.name,
          roomState: room.state,
        });
        return;
      }

      const signature = buildIceTransportSignature(diagnostics);
      if (signature === this.lastSignature) return;
      this.lastSignature = signature;

      const { myUserId, partnerUserId } = this.host.describeParticipants();
      logger.info('[VideoCallSession] Selected ICE transport path', {
        reason,
        roomName: room.name,
        roomState: room.state,
        myUserId,
        partnerUserId,
        transports: diagnostics,
      });
    } catch (e) {
      logger.debug('[VideoCallSession] ICE transport diagnostics failed (ignored)', e);
    }
  }
}
