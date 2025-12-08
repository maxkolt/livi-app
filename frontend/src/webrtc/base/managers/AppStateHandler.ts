import { AppState, AppStateStatus } from 'react-native';

/**
 * Обработчик состояния приложения (AppState)
 * Отслеживает переходы между foreground и background для управления WebRTC сессией
 */
export class AppStateHandler {
  private appStateSubscription: any = null;
  private wasInBackgroundRef: boolean = false;

  /**
   * Настроить слушатель AppState
   * Вызывает callbacks при переходе между foreground и background
   */
  setupAppStateListener(
    onForeground: () => void,
    onBackground: () => void
  ): void {
    if (this.appStateSubscription) {
      return;
    }
    
    this.appStateSubscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      this.handleAppStateChange(nextAppState, onForeground, onBackground);
    });
  }

  /**
   * Обработать изменение состояния приложения
   */
  private handleAppStateChange(
    nextAppState: AppStateStatus,
    onForeground: () => void,
    onBackground: () => void
  ): void {
    if (nextAppState === 'active' && this.wasInBackgroundRef) {
      onForeground();
      this.wasInBackgroundRef = false;
    } else if (nextAppState !== 'active') {
      onBackground();
      this.wasInBackgroundRef = true;
    }
  }

  /**
   * Получить флаг, был ли приложение в фоне
   */
  wasInBackground(): boolean {
    return this.wasInBackgroundRef;
  }

  /**
   * Удалить слушатель AppState
   */
  removeAppStateListener(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
  }

  /**
   * Сбросить состояние
   */
  reset(): void {
    this.wasInBackgroundRef = false;
    this.removeAppStateListener();
  }
}

