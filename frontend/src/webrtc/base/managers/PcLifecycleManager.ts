import { RTCPeerConnection } from 'react-native-webrtc';
import { logger } from '../../../../utils/logger';

/**
 * Менеджер жизненного цикла PeerConnection
 * Управляет токенами, валидацией и очисткой PC
 */
export class PcLifecycleManager {
  private pcToken: number = 0;
  private pcCreationInProgressRef: boolean = false;

  // ==================== Token Management ====================

  /**
   * Инкрементировать токен PC
   * Токен используется для отслеживания актуальности PC при асинхронных операциях
   * 
   * @param forceReset - сбросить токен перед инкрементом (по умолчанию true)
   */
  incrementPcToken(forceReset: boolean = true): void {
    if (forceReset) {
      this.pcToken = 0;
    }
    this.pcToken++;
  }

  /**
   * Получить текущий токен PC
   */
  getPcToken(): number {
    return this.pcToken;
  }

  /**
   * Пометить PC текущим токеном
   * Позволяет отслеживать, какой PC соответствует текущему токену
   */
  markPcWithToken(pc: RTCPeerConnection): void {
    (pc as any)._pcToken = this.pcToken;
  }

  /**
   * Проверить валидность токена PC
   * 
   * @param pc - PeerConnection для проверки
   * @param expectedToken - ожидаемый токен (если не указан, используется текущий)
   * @returns true если токен совпадает
   */
  isPcTokenValid(pc: RTCPeerConnection | null, expectedToken?: number): boolean {
    if (!pc) return false;
    const token = (pc as any)?._pcToken;
    const expected = expectedToken !== undefined ? expectedToken : this.pcToken;
    return token === expected;
  }

  /**
   * Проверить валидность PC (не закрыт и имеет правильный токен)
   * 
   * @param pc - PeerConnection для проверки
   * @param expectedToken - ожидаемый токен (если не указан, используется текущий)
   * @returns true если PC валиден
   */
  isPcValid(pc: RTCPeerConnection | null, expectedToken?: number): boolean {
    if (!pc) return false;
    if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') return false;
    return this.isPcTokenValid(pc, expectedToken);
  }

  // ==================== PC Creation State ====================

  /**
   * Установить флаг создания PC
   * Используется для предотвращения параллельного создания нескольких PC
   */
  setPcCreationInProgress(inProgress: boolean): void {
    this.pcCreationInProgressRef = inProgress;
  }

  /**
   * Проверить, создается ли PC в данный момент
   */
  isPcCreationInProgress(): boolean {
    return this.pcCreationInProgressRef;
  }

  // ==================== Cleanup ====================

  /**
   * Очистить PeerConnection
   * Удаляет все треки из senders и закрывает соединение
   */
  cleanupPeer(pc?: RTCPeerConnection | null): void {
    if (!pc) return;
    
    try {
      const senders = pc.getSenders();
      senders.forEach((sender: any) => {
        try {
          if (sender.track) {
            sender.track.stop();
          }
          pc.removeTrack(sender);
        } catch (e) {
          logger.warn('[PcLifecycleManager] Error removing sender:', e);
        }
      });
      
      if (pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
        pc.close();
      }
    } catch (e) {
      logger.warn('[PcLifecycleManager] Error cleaning up peer:', e);
    }
  }

  // ==================== Reset ====================

  /**
   * Сбросить состояние менеджера
   */
  reset(): void {
    this.pcToken = 0;
    this.pcCreationInProgressRef = false;
  }
}

