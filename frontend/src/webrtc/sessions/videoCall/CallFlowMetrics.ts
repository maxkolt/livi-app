/**
 * Тайминги этапов установления звонка: accept-ack → LiveKit connect → publish → первый
 * удалённый медиа-кадр.
 *
 * Раньше это были восемь разрозненных полей сессии и три копии формулы «если старт > 0 и
 * финиш не раньше старта — вернуть разницу». Теперь состояние и формулы живут вместе;
 * сессия только отмечает события и спрашивает готовые latency.
 */
export class CallFlowMetrics {
  /** call:accept отправлен / подтверждён сервером. */
  acceptAckStartedAt = 0;
  acceptAckCompletedAt = 0;
  /** room.connect() начат / комната подключена. */
  livekitConnectStartedAt = 0;
  livekitConnectedAt = 0;
  /** Локальные треки опубликованы. */
  publishCompletedAt = 0;
  /** Первая подписка на удалённый трек. */
  subscribeFirstSeenAt = 0;
  /** Момент, когда комната перешла в connected (база для «первого кадра»). */
  roomConnectedAt = 0;
  /** Первое удалённое медиа в этом подключении; 0 — ещё не видели. */
  remoteMediaFirstSeenAt = 0;

  /**
   * Сброс этапов подключения перед новой попыткой.
   * roomConnectedAt / remoteMediaFirstSeenAt живут по своему циклу и здесь не трогаются —
   * так же, как в исходном resetCallFlowMetrics.
   */
  resetConnectStages(): void {
    this.acceptAckStartedAt = 0;
    this.acceptAckCompletedAt = 0;
    this.livekitConnectStartedAt = 0;
    this.livekitConnectedAt = 0;
    this.publishCompletedAt = 0;
    this.subscribeFirstSeenAt = 0;
  }

  markAcceptAckStarted(at: number = Date.now()): void {
    this.acceptAckStartedAt = at;
  }

  markAcceptAckCompleted(at: number = Date.now()): void {
    this.acceptAckCompletedAt = at;
  }

  markLiveKitConnectStarted(at: number): void {
    this.livekitConnectStartedAt = at;
  }

  /** Комната подключена: это же время — база для publish/subscribe-латентностей. */
  markRoomConnected(at: number = Date.now()): void {
    this.roomConnectedAt = at;
    this.livekitConnectedAt = at;
  }

  markPublishCompleted(at: number = Date.now()): void {
    this.publishCompletedAt = at;
  }

  /** Первое удалённое медиа; возвращает зафиксированную метку времени. */
  markRemoteMediaFirstSeen(at: number = Date.now()): number {
    this.remoteMediaFirstSeenAt = at;
    this.subscribeFirstSeenAt = at;
    return at;
  }

  /** Новое подключение / новый watchdog-цикл: ждём первое медиа заново. */
  resetRemoteMediaFirstSeen(): void {
    this.remoteMediaFirstSeenAt = 0;
  }

  hasSeenRemoteMedia(): boolean {
    return this.remoteMediaFirstSeenAt !== 0;
  }

  private static span(from: number, to: number): number | undefined {
    if (from > 0 && to >= from) return to - from;
    return undefined;
  }

  getAcceptAckLatencyMs(): number | undefined {
    return CallFlowMetrics.span(this.acceptAckStartedAt, this.acceptAckCompletedAt);
  }

  getLiveKitConnectLatencyMs(): number | undefined {
    return CallFlowMetrics.span(this.livekitConnectStartedAt, this.livekitConnectedAt);
  }

  getPublishLatencyMs(): number | undefined {
    return CallFlowMetrics.span(this.livekitConnectedAt, this.publishCompletedAt);
  }

  /** От publish, а если publish не отмечен — от connect. */
  getSubscribeLatencyMs(): number | undefined {
    return (
      CallFlowMetrics.span(this.publishCompletedAt, this.subscribeFirstSeenAt) ??
      CallFlowMetrics.span(this.livekitConnectedAt, this.subscribeFirstSeenAt)
    );
  }

  /** От подключения комнаты до первого удалённого медиа. */
  getFirstRemoteMediaMs(): number | undefined {
    if (this.roomConnectedAt <= 0) return undefined;
    return Math.max(0, this.remoteMediaFirstSeenAt - this.roomConnectedAt);
  }

  /** От accept-ack до первого удалённого медиа — сквозное «время до картинки». */
  getTotalFromAcceptMs(): number | undefined {
    if (this.acceptAckStartedAt <= 0) return undefined;
    return Math.max(0, this.remoteMediaFirstSeenAt - this.acceptAckStartedAt);
  }

  /** Разбивка по этапам для client-metrics; ключи отсутствуют, если этап не измерен. */
  buildStageMetrics(): Record<string, number> {
    const stageMetrics: Record<string, number> = {};
    const acceptAckLatencyMs = this.getAcceptAckLatencyMs();
    if (acceptAckLatencyMs !== undefined) stageMetrics.acceptAckLatencyMs = acceptAckLatencyMs;
    const livekitConnectLatencyMs = this.getLiveKitConnectLatencyMs();
    if (livekitConnectLatencyMs !== undefined) stageMetrics.livekitConnectLatencyMs = livekitConnectLatencyMs;
    const publishLatencyMs = this.getPublishLatencyMs();
    if (publishLatencyMs !== undefined) stageMetrics.publishLatencyMs = publishLatencyMs;
    const subscribeLatencyMs = this.getSubscribeLatencyMs();
    if (subscribeLatencyMs !== undefined) stageMetrics.subscribeLatencyMs = subscribeLatencyMs;
    return stageMetrics;
  }
}
