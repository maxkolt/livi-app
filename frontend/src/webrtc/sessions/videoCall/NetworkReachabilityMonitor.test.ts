import { NetworkReachabilityMonitor, type NetworkReachabilityHost } from './NetworkReachabilityMonitor';

const netinfo = require('@react-native-community/netinfo') as {
  __emit: (state: any) => void;
  __setState: (state: any) => void;
  __listenerCount: () => number;
};

const online = { isConnected: true, isInternetReachable: true } as any;
const offline = { isConnected: false, isInternetReachable: false } as any;

function makeHost(over: Partial<NetworkReachabilityHost> = {}) {
  return {
    isCallActive: jest.fn(() => true),
    hasLiveKitCredsForRejoin: jest.fn(() => true),
    onLinkLost: jest.fn(),
    onLinkRestored: jest.fn(),
    ...over,
  } as NetworkReachabilityHost & Record<string, jest.Mock>;
}

describe('NetworkReachabilityMonitor', () => {
  describe('переходы достижимости', () => {
    it('true → false зовёт onLinkLost', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(online);
      monitor.handleState(offline);
      expect(host.onLinkLost).toHaveBeenCalledTimes(1);
      expect(host.onLinkRestored).not.toHaveBeenCalled();
    });

    it('false → true зовёт onLinkRestored', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(offline);
      monitor.handleState(online);
      expect(host.onLinkRestored).toHaveBeenCalledTimes(1);
      expect(host.onLinkLost).not.toHaveBeenCalled();
    });

    it('первое состояние только запоминается, но не действует', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(offline);
      expect(host.onLinkLost).not.toHaveBeenCalled();
      expect(host.onLinkRestored).not.toHaveBeenCalled();
    });

    it('повторы того же состояния не дёргают колбэки', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(online);
      monitor.handleState(online);
      monitor.handleState(offline);
      monitor.handleState(offline);
      expect(host.onLinkLost).toHaveBeenCalledTimes(1);
    });

    it('isInternetReachable === null считается достижимостью', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(offline);
      monitor.handleState({ isConnected: true, isInternetReachable: null } as any);
      expect(host.onLinkRestored).toHaveBeenCalledTimes(1);
    });
  });

  describe('условия молчания', () => {
    it('завершающийся звонок не обрабатывает события', () => {
      const host = makeHost({ isCallActive: jest.fn(() => false) });
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(online);
      monitor.handleState(offline);
      expect(host.onLinkLost).not.toHaveBeenCalled();
    });

    it('без LiveKit-кредов перезаходить некуда — колбэков нет', () => {
      const host = makeHost({ hasLiveKitCredsForRejoin: jest.fn(() => false) });
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(online);
      monitor.handleState(offline);
      expect(host.onLinkLost).not.toHaveBeenCalled();
    });

    it('но состояние всё равно запоминается: после появления кредов ложного «restored» не будет', () => {
      let hasCreds = false;
      const host = makeHost({ hasLiveKitCredsForRejoin: jest.fn(() => hasCreds) });
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.handleState(online);
      hasCreds = true;
      monitor.handleState(online);
      expect(host.onLinkRestored).not.toHaveBeenCalled();
    });
  });

  describe('подписка', () => {
    it('start подписывается, stop отписывается', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      const before = netinfo.__listenerCount();
      monitor.start();
      expect(monitor.isRunning()).toBe(true);
      expect(netinfo.__listenerCount()).toBe(before + 1);
      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
      expect(netinfo.__listenerCount()).toBe(before);
    });

    it('повторный start не плодит подписки', () => {
      const monitor = new NetworkReachabilityMonitor(makeHost());
      const before = netinfo.__listenerCount();
      monitor.start();
      monitor.start();
      expect(netinfo.__listenerCount()).toBe(before + 1);
      monitor.stop();
    });

    it('не подписывается, когда звонок уже завершается', () => {
      const monitor = new NetworkReachabilityMonitor(makeHost({ isCallActive: jest.fn(() => false) }));
      const before = netinfo.__listenerCount();
      monitor.start();
      expect(monitor.isRunning()).toBe(false);
      expect(netinfo.__listenerCount()).toBe(before);
    });

    it('события из NetInfo доходят до хоста', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.start();
      netinfo.__emit(online);
      netinfo.__emit(offline);
      expect(host.onLinkLost).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it('после stop события больше не доходят', () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.start();
      netinfo.__emit(online);
      monitor.stop();
      netinfo.__emit(offline);
      expect(host.onLinkLost).not.toHaveBeenCalled();
    });

    it('stop сбрасывает прошлое состояние: следующий цикл начинается с чистого листа', async () => {
      const host = makeHost();
      const monitor = new NetworkReachabilityMonitor(host);
      monitor.start();
      netinfo.__emit(online);
      monitor.stop();
      monitor.start();
      netinfo.__emit(offline);
      expect(host.onLinkLost).not.toHaveBeenCalled();
      monitor.stop();
    });
  });
});
