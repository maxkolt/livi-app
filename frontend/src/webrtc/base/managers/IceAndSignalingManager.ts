import { RTCPeerConnection } from 'react-native-webrtc';
import { getIceConfiguration, getEnvFallbackConfiguration } from '../../../../utils/iceConfig';
import { logger } from '../../../../utils/logger';
import socket from '../../../../sockets/socket';
import { hashString } from '../utils/hashUtils';

/**
 * Менеджер ICE конфигурации и signaling (offer/answer)
 * Управляет ICE кандидатами, обработкой offer/answer и предотвращением дубликатов
 */
export class IceAndSignalingManager {
  private iceConfigRef: RTCConfiguration | null = null;
  private pendingIceByFromRef: Record<string, any[]> = {};
  private outgoingIceCache: any[] = [];
  
  // Offer/Answer processing
  private processingOffersRef: Set<string> = new Set();
  private processingAnswersRef: Set<string> = new Set();
  private processedOffersRef: Set<string> = new Set();
  private processedAnswersRef: Set<string> = new Set();
  private offerCounterByKeyRef: Map<string, number> = new Map();
  private answerCounterByKeyRef: Map<string, number> = new Map();

  constructor() {
    this.loadIceConfiguration();
  }

  // ==================== ICE Configuration ====================

  /**
   * Загрузить ICE конфигурацию
   * Проверяет наличие TURN серверов для NAT traversal
   */
  async loadIceConfiguration(): Promise<void> {
    try {
      const config = await getIceConfiguration();
      this.iceConfigRef = config;
      this.logTurnServerStatus(config);
    } catch (error) {
      logger.error('[IceAndSignalingManager] Failed to load ICE configuration:', error);
      this.iceConfigRef = getEnvFallbackConfiguration();
      this.logTurnServerStatus(this.iceConfigRef);
    }
  }

  /**
   * Проверить и залогировать наличие TURN серверов
   */
  private logTurnServerStatus(config: RTCConfiguration): void {
    const hasTurn = config.iceServers?.some((server: any) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((u: string) => u && u.startsWith('turn:'));
    }) ?? false;
    
    if (!hasTurn) {
      logger.warn('[IceAndSignalingManager] No TURN server in ICE configuration - NAT traversal may fail');
    } else {
      logger.info('[IceAndSignalingManager] TURN server found in ICE configuration');
    }
  }

  /**
   * Получить ICE конфигурацию
   * Возвращает загруженную конфигурацию или fallback
   */
  getIceConfig(): RTCConfiguration {
    if (this.iceConfigRef) {
      return this.iceConfigRef;
    }
    return getEnvFallbackConfiguration();
  }

  // ==================== SDP Optimization ====================

  /**
   * Оптимизировать SDP для быстрого соединения
   * Удаляет неиспользуемые кодеки для уменьшения размера SDP
   */
  optimizeSdpForFastConnection(sdp: string): string {
    return sdp.replace(/a=rtpmap:\d+ (red|ulpfec|rtx|flexfec)/gi, '');
  }

  // ==================== Outgoing ICE Candidates ====================

  /**
   * Отправить кешированные исходящие ICE кандидаты
   * Вызывается после установки partnerId для отправки ранее кешированных кандидатов
   */
  flushOutgoingIceCache(partnerId: string | null, isFriendCall: () => boolean, roomId: string | null): void {
    if (this.outgoingIceCache.length === 0 || !partnerId) {
      return;
    }
    
    for (const candidate of this.outgoingIceCache) {
      try {
        const payload: any = { to: partnerId, candidate };
        if (isFriendCall() && roomId) {
          payload.roomId = roomId;
        }
        socket.emit('ice-candidate', payload);
      } catch (e) {
        logger.warn('[IceAndSignalingManager] Error sending cached ICE candidate:', e);
      }
    }
    
    this.outgoingIceCache = [];
  }

  /**
   * Кешировать исходящий ICE кандидат
   * Используется когда partnerId еще не установлен
   */
  cacheOutgoingIce(candidate: any): void {
    this.outgoingIceCache.push(candidate);
  }

  /**
   * Очистить кеш исходящих ICE кандидатов
   */
  clearOutgoingIceCache(): void {
    this.outgoingIceCache = [];
  }

  // ==================== Incoming ICE Candidates ====================

  /**
   * Поставить в очередь входящий ICE кандидат
   * Кандидаты кешируются до установки remoteDescription
   * КРИТИЧНО: Кладём кандидаты как по from (socket.id), так и по roomId (если есть),
   * чтобы они были доступны при флашинге по любому из этих ключей
   */
  enqueueIce(from: string, candidate: any, roomId?: string | null): void {
    const fromKey = String(from || '');
    if (!this.pendingIceByFromRef[fromKey]) {
      this.pendingIceByFromRef[fromKey] = [];
    }
    this.pendingIceByFromRef[fromKey].push(candidate);
    
    // КРИТИЧНО: Также кладём по roomId, если он есть
    // Это позволяет найти кандидаты даже если partnerSocketIdRef ещё не установлен
    if (roomId) {
      const roomKey = String(roomId);
      if (!this.pendingIceByFromRef[roomKey]) {
        this.pendingIceByFromRef[roomKey] = [];
      }
      // Кладём тот же кандидат по ключу roomId
      this.pendingIceByFromRef[roomKey].push(candidate);
    }
  }
  
  /**
   * Получить все ключи из очереди отложенных кандидатов
   * Используется для проверки всех возможных ключей при флашинге
   */
  getAllPendingKeys(): string[] {
    return Object.keys(this.pendingIceByFromRef);
  }
  
  /**
   * Получить все уникальные кандидаты из указанных ключей
   * Дедуплицирует кандидаты по их строковому представлению
   * КРИТИЧНО: Один и тот же кандидат может быть в разных ключах (from и roomId),
   * поэтому нужно дедуплицировать перед добавлением в PC
   */
  getAllUniqueCandidates(keys: string[]): any[] {
    const candidateMap = new Map<string, any>();
    
    for (const key of keys) {
      const candidates = this.pendingIceByFromRef[key] || [];
      for (const candidate of candidates) {
        // Создаем уникальный ключ для кандидата
        // Используем строку кандидата и его индексы для идентификации
        const candidateKey = this.getCandidateKey(candidate);
        if (!candidateMap.has(candidateKey)) {
          candidateMap.set(candidateKey, candidate);
        }
      }
    }
    
    return Array.from(candidateMap.values());
  }
  
  /**
   * Создать уникальный ключ для кандидата
   * Используется для дедупликации
   */
  private getCandidateKey(candidate: any): string {
    // Используем строку кандидата и его индексы для уникальной идентификации
    const candidateStr = candidate?.candidate || '';
    const sdpMLineIndex = candidate?.sdpMLineIndex ?? '';
    const sdpMid = candidate?.sdpMid || '';
    return `${candidateStr}_${sdpMLineIndex}_${sdpMid}`;
  }
  
  /**
   * Удалить очередь кандидатов по ключу
   * Используется после успешной обработки всех кандидатов
   */
  deletePendingQueue(key: string): void {
    delete this.pendingIceByFromRef[key];
  }
  
  /**
   * Удалить очереди кандидатов по нескольким ключам
   * Используется после успешной обработки всех кандидатов из нескольких ключей
   */
  deletePendingQueues(keys: string[]): void {
    for (const key of keys) {
      delete this.pendingIceByFromRef[key];
    }
  }

  /**
   * Обработать отложенные ICE кандидаты для партнера
   * Добавляет все кешированные кандидаты в PC после установки remoteDescription
   * КРИТИЧНО: Не удаляем очередь из-за несовпадения идентификаторов.
   * В прямых звонках partnerId - это userId, а from - это socket.id, поэтому они никогда не совпадают.
   * Кандидаты должны приниматься по ключу from (socket.id) или по совпадению roomId, а не по partnerId.
   * Удаляем очередь только после успешного добавления всех кандидатов в PC.
   */
  async flushIceFor(
    from: string,
    pc: RTCPeerConnection | null,
    isPcValid: (pc: RTCPeerConnection | null) => boolean,
    partnerId: string | null
  ): Promise<void> {
    const key = String(from || '');
    const list = this.pendingIceByFromRef[key] || [];
    
    if (!pc || !list.length) {
      return;
    }
    
    // Если PC невалиден, удаляем очередь (PC больше не будет использоваться)
    if (!isPcValid(pc)) {
      this.deletePendingQueue(key);
      return;
    }
    
    // КРИТИЧНО: НЕ удаляем очередь из-за несовпадения идентификаторов
    // В прямых звонках partnerId - это userId, а from - это socket.id,
    // поэтому они никогда не совпадают. Кандидаты должны приниматься по ключу from (socket.id)
    // или по совпадению roomId, а не по partnerId.
    // Старая проверка "if (partnerId && partnerId !== from)" удаляла все кандидаты и не давала ICE установиться.
    
    // Если remoteDescription еще не установлен, не удаляем очередь - попробуем позже
    const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
    if (!hasRemoteDesc) {
      return;
    }
    
    logger.debug('[IceAndSignalingManager] Flushing ICE candidates', {
      key,
      count: list.length,
      partnerId,
      from,
      note: 'Accepting candidates by socket.id key, not by userId comparison'
    });
    
    // Добавляем все кандидаты в PC
    for (const cand of list) {
      try {
        await pc.addIceCandidate(cand);
      } catch (e: any) {
        const errorMsg = String(e?.message || '');
        if (!errorMsg.includes('InvalidStateError') && 
            !errorMsg.includes('already exists') && 
            !errorMsg.includes('closed')) {
          logger.warn('[IceAndSignalingManager] Error adding queued ICE candidate:', e);
        }
      }
    }
    
    // Удаляем очередь только после успешного добавления всех кандидатов
    this.deletePendingQueue(key);
  }

  // ==================== Offer/Answer Key Management ====================

  /**
   * Создать уникальный ключ для offer на основе SDP
   * Используется для предотвращения обработки дубликатов
   */
  createOfferKey(from: string, pcToken: number, offerSdp: string): string {
    const sdpHash = hashString(offerSdp);
    const counterKey = `${from}_${pcToken}`;
    let counter = this.offerCounterByKeyRef.get(counterKey) || 0;
    
    const existingKeyWithSameHash = Array.from(this.processedOffersRef).find(key => 
      key.startsWith(`offer_${from}_${pcToken}_${sdpHash}_`)
    );
    
    if (!existingKeyWithSameHash) {
      counter++;
      this.offerCounterByKeyRef.set(counterKey, counter);
    }
    
    return `offer_${from}_${pcToken}_${sdpHash}_${counter}`;
  }

  /**
   * Создать уникальный ключ для answer на основе SDP
   * Используется для предотвращения обработки дубликатов
   */
  createAnswerKey(from: string, pcToken: number, answerSdp: string): string {
    const sdpHash = hashString(answerSdp);
    const counterKey = `${from}_${pcToken}`;
    let counter = this.answerCounterByKeyRef.get(counterKey) || 0;
    
    const existingKeyWithSameHash = Array.from(this.processedAnswersRef).find(key => 
      key.startsWith(`answer_${from}_${pcToken}_${sdpHash}_`)
    );
    
    if (!existingKeyWithSameHash) {
      counter++;
      this.answerCounterByKeyRef.set(counterKey, counter);
    }
    
    return `answer_${from}_${pcToken}_${sdpHash}_${counter}`;
  }

  // ==================== Offer Processing State ====================

  /**
   * Проверить, обрабатывается ли offer в данный момент
   */
  isProcessingOffer(key: string): boolean {
    return this.processingOffersRef.has(key);
  }

  /**
   * Отметить offer как обрабатываемый
   */
  markOfferProcessing(key: string): void {
    this.processingOffersRef.add(key);
  }

  /**
   * Отметить offer как обработанный
   */
  markOfferProcessed(key: string): void {
    this.processingOffersRef.delete(key);
    this.processedOffersRef.add(key);
  }

  /**
   * Проверить, обработан ли offer ранее
   */
  isOfferProcessed(key: string): boolean {
    return this.processedOffersRef.has(key);
  }

  // ==================== Answer Processing State ====================

  /**
   * Проверить, обрабатывается ли answer в данный момент
   */
  isProcessingAnswer(key: string): boolean {
    return this.processingAnswersRef.has(key);
  }

  /**
   * Отметить answer как обрабатываемый
   */
  markAnswerProcessing(key: string): void {
    this.processingAnswersRef.add(key);
  }

  /**
   * Отметить answer как обработанный
   */
  markAnswerProcessed(key: string): void {
    this.processingAnswersRef.delete(key);
    this.processedAnswersRef.add(key);
  }

  /**
   * Проверить, обработан ли answer ранее
   */
  isAnswerProcessed(key: string): boolean {
    return this.processedAnswersRef.has(key);
  }

  // ==================== Reset ====================

  /**
   * Сбросить состояние менеджера
   */
  reset(): void {
    this.pendingIceByFromRef = {};
    this.outgoingIceCache = [];
    this.processingOffersRef.clear();
    this.processingAnswersRef.clear();
    this.processedOffersRef.clear();
    this.processedAnswersRef.clear();
    this.offerCounterByKeyRef.clear();
    this.answerCounterByKeyRef.clear();
  }
}

