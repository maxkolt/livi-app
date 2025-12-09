import type { WebRTCSessionConfig } from '../../types';

/**
 * Менеджер состояния удаленного партнера
 * Управляет состоянием камеры, аудио и отложенными cam-toggle событиями
 */
export class RemoteStateManager {
  private remoteCamOnRef: boolean = true;
  private remoteForcedOffRef: boolean = false;
  private camToggleSeenRef: boolean = false;
  private remoteViewKeyRef: number = 0;
  private remoteMutedRef: boolean = false;
  private pendingCamToggleRef: { enabled: boolean; from: string; timestamp: number } | null = null;
  private connectionEstablishedAtRef: number = 0;
  private config: WebRTCSessionConfig;

  constructor(config: WebRTCSessionConfig) {
    this.config = config;
  }

  // ==================== Camera State ====================

  /**
   * Получить состояние удаленной камеры
   */
  isRemoteCamOn(): boolean {
    return this.remoteCamOnRef;
  }

  /**
   * Установить состояние удаленной камеры
   * Вызывает callbacks ТОЛЬКО при изменении значения
   * УБРАНО: Автоматические callbacks без изменения значения - это вызывало лишние переключения на Android
   */
  setRemoteCamOn(enabled: boolean, emit: (event: string, ...args: any[]) => void): void {
    const oldValue = this.remoteCamOnRef;
    
    // Обновляем значение только если оно изменилось
    if (oldValue !== enabled) {
      this.remoteCamOnRef = enabled;
      this.config.callbacks.onRemoteCamStateChange?.(enabled);
      this.config.onRemoteCamStateChange?.(enabled);
      emit('remoteCamStateChanged', enabled);
    }
    // УБРАНО: Не вызываем callbacks если значение не изменилось - это предотвращает лишние переключения
  }

  /**
   * Получить флаг принудительного выключения камеры
   * Используется для предотвращения автоматического обновления состояния через track checker
   */
  isRemoteForcedOff(): boolean {
    return this.remoteForcedOffRef;
  }

  /**
   * Установить флаг принудительного выключения камеры
   */
  setRemoteForcedOff(forced: boolean): void {
    this.remoteForcedOffRef = forced;
  }

  /**
   * Получить ключ для обновления удаленного видео
   * Используется для принудительного обновления React компонента
   */
  getRemoteViewKey(): number {
    return this.remoteViewKeyRef;
  }

  /**
   * Обновить ключ для обновления удаленного видео
   */
  updateRemoteViewKey(emit: (event: string, ...args: any[]) => void): void {
    this.remoteViewKeyRef = Date.now();
    emit('remoteViewKeyChanged', this.remoteViewKeyRef);
  }

  // ==================== Audio State ====================

  /**
   * Получить состояние удаленного аудио (muted)
   */
  isRemoteMuted(): boolean {
    return this.remoteMutedRef;
  }

  /**
   * Установить состояние удаленного аудио (muted)
   */
  setRemoteMuted(muted: boolean): void {
    this.remoteMutedRef = muted;
  }

  // ==================== Pending Cam Toggle ====================

  /**
   * Получить отложенное состояние cam-toggle
   * Используется когда cam-toggle приходит до установки remote stream
   */
  getPendingCamToggle(): { enabled: boolean; from: string; timestamp: number } | null {
    return this.pendingCamToggleRef;
  }

  /**
   * Установить отложенное состояние cam-toggle
   */
  setPendingCamToggle(pending: { enabled: boolean; from: string; timestamp: number } | null): void {
    this.pendingCamToggleRef = pending;
  }

  // ==================== Connection Time ====================

  /**
   * Установить время установки соединения
   * Используется для проверки стабильности треков
   */
  setConnectionEstablishedAt(timestamp: number): void {
    this.connectionEstablishedAtRef = timestamp;
  }

  /**
   * Получить время установки соединения
   */
  getConnectionEstablishedAt(): number {
    return this.connectionEstablishedAtRef;
  }

  // ==================== State Emission ====================

  /**
   * Эмитить состояние удаленного партнера
   * Отправляет полное состояние через event emitter
   */
  emitRemoteState(emit: (event: string, ...args: any[]) => void, remoteInPiP: boolean): void {
    emit('remoteState', {
      camOn: this.remoteCamOnRef,
      muted: this.remoteMutedRef,
      inPiP: remoteInPiP,
      remoteViewKey: this.remoteViewKeyRef,
    });
  }

  // ==================== Reset ====================

  /**
   * Сбросить состояние удаленного партнера
   */
  reset(emit: (event: string, ...args: any[]) => void): void {
    this.remoteCamOnRef = false;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.remoteViewKeyRef = 0;
    this.remoteMutedRef = false;
    this.pendingCamToggleRef = null;
    this.connectionEstablishedAtRef = 0;
    
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    emit('remoteCamStateChanged', false);
    emit('remoteViewKeyChanged', 0);
  }
}

