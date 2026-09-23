import { CallFlowMetrics } from './CallFlowMetrics';

describe('CallFlowMetrics', () => {
  let metrics: CallFlowMetrics;

  beforeEach(() => {
    metrics = new CallFlowMetrics();
  });

  describe('latency этапов', () => {
    it('accept-ack считается от старта до подтверждения', () => {
      metrics.markAcceptAckStarted(1000);
      metrics.markAcceptAckCompleted(1250);
      expect(metrics.getAcceptAckLatencyMs()).toBe(250);
    });

    it('этап без старта не измеряется', () => {
      metrics.markAcceptAckCompleted(1250);
      expect(metrics.getAcceptAckLatencyMs()).toBeUndefined();
    });

    it('финиш раньше старта (перезапуск/рассинхрон часов) не даёт отрицательной latency', () => {
      metrics.markAcceptAckStarted(2000);
      metrics.markAcceptAckCompleted(1000);
      expect(metrics.getAcceptAckLatencyMs()).toBeUndefined();
    });

    it('connect считается от room.connect() до connected', () => {
      metrics.markLiveKitConnectStarted(1000);
      metrics.markRoomConnected(1800);
      expect(metrics.getLiveKitConnectLatencyMs()).toBe(800);
    });

    it('publish считается от connected', () => {
      metrics.markRoomConnected(1000);
      metrics.markPublishCompleted(1300);
      expect(metrics.getPublishLatencyMs()).toBe(300);
    });

    it('subscribe считается от publish, когда publish отмечен', () => {
      metrics.markRoomConnected(1000);
      metrics.markPublishCompleted(1200);
      metrics.markRemoteMediaFirstSeen(1500);
      expect(metrics.getSubscribeLatencyMs()).toBe(300);
    });

    it('subscribe падает на connected, если publish не отмечен', () => {
      metrics.markRoomConnected(1000);
      metrics.markRemoteMediaFirstSeen(1500);
      expect(metrics.getSubscribeLatencyMs()).toBe(500);
    });
  });

  describe('первое удалённое медиа', () => {
    it('фиксирует метку и синхронизирует subscribeFirstSeenAt', () => {
      expect(metrics.hasSeenRemoteMedia()).toBe(false);
      expect(metrics.markRemoteMediaFirstSeen(1500)).toBe(1500);
      expect(metrics.hasSeenRemoteMedia()).toBe(true);
      expect(metrics.subscribeFirstSeenAt).toBe(1500);
    });

    it('время до первого кадра считается от подключения комнаты и от accept-ack', () => {
      metrics.markAcceptAckStarted(1000);
      metrics.markRoomConnected(1400);
      metrics.markRemoteMediaFirstSeen(1900);
      expect(metrics.getFirstRemoteMediaMs()).toBe(500);
      expect(metrics.getTotalFromAcceptMs()).toBe(900);
    });

    it('без базовых меток сквозные времена не считаются', () => {
      metrics.markRemoteMediaFirstSeen(1900);
      expect(metrics.getFirstRemoteMediaMs()).toBeUndefined();
      expect(metrics.getTotalFromAcceptMs()).toBeUndefined();
    });

    it('resetRemoteMediaFirstSeen возвращает сессию в ожидание медиа', () => {
      metrics.markRemoteMediaFirstSeen(1500);
      metrics.resetRemoteMediaFirstSeen();
      expect(metrics.hasSeenRemoteMedia()).toBe(false);
    });
  });

  describe('buildStageMetrics', () => {
    it('содержит только измеренные этапы', () => {
      metrics.markAcceptAckStarted(1000);
      metrics.markAcceptAckCompleted(1100);
      expect(metrics.buildStageMetrics()).toEqual({ acceptAckLatencyMs: 100 });
    });

    it('полный путь даёт все четыре этапа', () => {
      metrics.markAcceptAckStarted(1000);
      metrics.markAcceptAckCompleted(1100);
      metrics.markLiveKitConnectStarted(1100);
      metrics.markRoomConnected(1600);
      metrics.markPublishCompleted(1700);
      metrics.markRemoteMediaFirstSeen(2000);
      expect(metrics.buildStageMetrics()).toEqual({
        acceptAckLatencyMs: 100,
        livekitConnectLatencyMs: 500,
        publishLatencyMs: 100,
        subscribeLatencyMs: 300,
      });
    });

    it('пустой объект, пока ничего не измерено', () => {
      expect(metrics.buildStageMetrics()).toEqual({});
    });
  });

  describe('resetConnectStages', () => {
    it('сбрасывает этапы подключения', () => {
      metrics.markAcceptAckStarted(1000);
      metrics.markAcceptAckCompleted(1100);
      metrics.markLiveKitConnectStarted(1100);
      metrics.markPublishCompleted(1700);
      metrics.resetConnectStages();
      expect(metrics.buildStageMetrics()).toEqual({});
    });

    it('НЕ трогает roomConnectedAt и remoteMediaFirstSeenAt (у них свой цикл)', () => {
      metrics.markRoomConnected(1600);
      metrics.markRemoteMediaFirstSeen(2000);
      metrics.resetConnectStages();
      expect(metrics.roomConnectedAt).toBe(1600);
      expect(metrics.remoteMediaFirstSeenAt).toBe(2000);
    });
  });
});
