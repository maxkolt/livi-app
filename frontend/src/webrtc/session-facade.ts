/**
 * Фасад для WebRTCSession
 * Использует VideoCallSession или RandomChatSession в зависимости от режима
 * Сохраняет обратную совместимость со старым API
 */

import { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import { SimpleEventEmitter } from './base/SimpleEventEmitter';
import { VideoCallSession } from './sessions/VideoCallSession';
import { RandomChatSession } from './sessions/RandomChatSession';
import type { WebRTCSessionConfig, CamSide } from './types';

export class WebRTCSessionFacade extends SimpleEventEmitter {
  private internalSession: VideoCallSession | RandomChatSession | null = null;
  private config: WebRTCSessionConfig;
  
  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    
    // Определяем тип сессии на основе конфигурации
    // Пока используем старую логику определения
    const isDirectCall = config.getIsDirectCall?.() ?? false;
    const inDirectCall = config.getInDirectCall?.() ?? false;
    const friendCallAccepted = config.getFriendCallAccepted?.() ?? false;
    const started = config.getStarted?.() ?? false;
    
    // Если это видеозвонок другу
    if (isDirectCall || inDirectCall || friendCallAccepted) {
      this.internalSession = new VideoCallSession(config);
    } else if (started) {
      // Если это рандомный чат
      this.internalSession = new RandomChatSession(config);
    } else {
      // По умолчанию создаем RandomChatSession (можно изменить логику)
      this.internalSession = new RandomChatSession(config);
    }
    
    // Проксируем события из внутренней сессии
    this.setupEventProxy();
  }
  
  private setupEventProxy(): void {
    if (!this.internalSession) return;
    
    // Проксируем все события из внутренней сессии
    const events = ['localStream', 'remoteStream', 'partnerId', 'roomId', 'callId', 
                   'connected', 'callEnded', 'callDeclined', 'searching', 'stopped', 'next'];
    
    events.forEach(event => {
      this.internalSession!.on(event as any, (...args: any[]) => {
        this.emit(event, ...args);
      });
    });
  }
  
  // ==================== Публичные методы для обратной совместимости ====================
  
  async startLocalStream(side: CamSide = 'front'): Promise<MediaStream | null> {
    if (!this.internalSession) return null;
    return this.internalSession.startLocalStream(side);
  }
  
  async stopLocalStream(preserveStreamForConnection: boolean = false, force: boolean = false): Promise<void> {
    if (this.internalSession) {
      return this.internalSession.stopLocalStream(preserveStreamForConnection, force);
    }
  }
  
  stopRemoteStream(): void {
    if (this.internalSession) {
      this.internalSession.stopRemoteStream();
    }
  }
  
  // Видеозвонки другу
  async callFriend(friendId: string): Promise<void> {
    if (this.internalSession instanceof VideoCallSession) {
      return this.internalSession.callFriend(friendId);
    }
    throw new Error('callFriend can only be called in VideoCallSession mode');
  }
  
  async acceptCall(callId?: string): Promise<void> {
    if (this.internalSession instanceof VideoCallSession) {
      return this.internalSession.acceptCall(callId);
    }
    throw new Error('acceptCall can only be called in VideoCallSession mode');
  }
  
  declineCall(callId?: string): void {
    if (this.internalSession instanceof VideoCallSession) {
      this.internalSession.declineCall(callId);
      return;
    }
    throw new Error('declineCall can only be called in VideoCallSession mode');
  }
  
  endCall(): void {
    if (this.internalSession instanceof VideoCallSession) {
      this.internalSession.endCall();
      return;
    }
    // Для RandomChatSession используем stopRandomChat
    if (this.internalSession instanceof RandomChatSession) {
      this.internalSession.stopRandomChat();
    }
  }
  
  // Рандомный чат
  async startRandomChat(): Promise<void> {
    if (this.internalSession instanceof RandomChatSession) {
      return this.internalSession.startRandomChat();
    }
    throw new Error('startRandomChat can only be called in RandomChatSession mode');
  }
  
  stopRandomChat(): void {
    if (this.internalSession instanceof RandomChatSession) {
      this.internalSession.stopRandomChat();
      return;
    }
  }
  
  stopRandom(): void {
    this.stopRandomChat();
  }
  
  nextRandom(): void {
    if (this.internalSession instanceof RandomChatSession) {
      this.internalSession.next();
      return;
    }
  }
  
  next(): void {
    this.nextRandom();
  }
  
  autoNext(reason?: string): void {
    if (this.internalSession instanceof RandomChatSession) {
      this.internalSession.autoNext(reason);
      return;
    }
  }
  
  // Управление медиа
  toggleMic(): void {
    if (this.internalSession) {
      this.internalSession.toggleMic();
    }
  }
  
  toggleCam(): void {
    if (this.internalSession) {
      this.internalSession.toggleCam();
    }
  }
  
  toggleRemoteAudio(): void {
    if (this.internalSession) {
      this.internalSession.toggleRemoteAudio();
    }
  }
  
  async flipCam(): Promise<void> {
    if (this.internalSession) {
      return this.internalSession.flipCam();
    }
  }
  
  async restartLocalCamera(): Promise<void> {
    if (this.internalSession) {
      return this.internalSession.restartLocalCamera();
    }
  }
  
  // Дополнительные методы
  setInPiP(inPiP: boolean): void {
    if (this.internalSession) {
      this.internalSession.setInPiP(inPiP);
    }
  }
  
  checkRemoteVideoTrack(): void {
    if (this.internalSession) {
      this.internalSession.checkRemoteVideoTrack();
    }
  }
  
  leaveRoom(roomId?: string): void {
    if (this.internalSession) {
      this.internalSession.leaveRoom(roomId);
    }
  }
  
  async resumeFromPiP(): Promise<void> {
    if (this.internalSession) {
      return this.internalSession.resumeFromPiP();
    }
  }
  
  // Дополнительные методы для обратной совместимости
  cleanupAfterFriendCallFailure(reason: 'timeout' | 'busy'): void {
    if (this.internalSession instanceof VideoCallSession) {
      this.internalSession.cleanupAfterFriendCallFailure(reason);
    }
  }
  
  handleExternalCallEnded(reason?: string, data?: any): void {
    if (this.internalSession instanceof VideoCallSession) {
      this.internalSession.handleExternalCallEnded(reason, data);
    }
  }
  
  handleRandomDisconnected(source: 'server' | 'local'): void {
    if (this.internalSession instanceof RandomChatSession) {
      this.internalSession.handleRandomDisconnected(source);
    }
  }
  
  // Геттеры
  getLocalStream(): MediaStream | null {
    if (!this.internalSession) return null;
    return this.internalSession.getLocalStream();
  }
  
  getRemoteStream(): MediaStream | null {
    if (!this.internalSession) return null;
    return this.internalSession.getRemoteStream();
  }
  
  getPartnerId(): string | null {
    if (!this.internalSession) return null;
    return this.internalSession.getPartnerId();
  }
  
  getRoomId(): string | null {
    if (!this.internalSession) return null;
    return this.internalSession.getRoomId();
  }
  
  getCallId(): string | null {
    if (!this.internalSession) return null;
    return this.internalSession.getCallId();
  }
  
  getPeerConnection(): RTCPeerConnection | null {
    if (!this.internalSession) return null;
    return this.internalSession.getPeerConnection();
  }
  
  // EventEmitter методы (делегируем во внутреннюю сессию)
  on(event: string, handler: (...args: any[]) => void): this {
    if (this.internalSession) {
      this.internalSession.on(event, handler);
    }
    return super.on(event, handler);
  }
  
  off(event: string, handler?: (...args: any[]) => void): this {
    if (this.internalSession) {
      this.internalSession.off(event, handler);
    }
    return super.off(event, handler);
  }
  
  once(event: string, handler: (...args: any[]) => void): this {
    if (this.internalSession) {
      this.internalSession.once(event, handler);
    }
    return super.once(event, handler);
  }
  
  emit(event: string, ...args: any[]): boolean {
    if (this.internalSession) {
      this.internalSession.emit(event, ...args);
    }
    return super.emit(event, ...args);
  }
  
  // Очистка
  removeAllListeners(event?: string): this {
    if (this.internalSession) {
      this.internalSession.removeAllListeners(event);
    }
    return super.removeAllListeners(event);
  }
  
  destroy(): void {
    if (this.internalSession) {
      this.internalSession.cleanup();
      this.internalSession = null;
    }
    this.removeAllListeners();
  }
  
  cleanup(): void {
    this.destroy();
  }
}

