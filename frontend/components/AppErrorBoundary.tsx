import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLang } from '../store/lang';
import { t } from '../utils/i18n';
import { trackReleaseError } from '../utils/telemetry';
import {
  HOME_NAV_BG,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  WELCOME_POPUP_ACCENT,
} from '../screens/home/constants';
import { WelcomeStageBackground } from '../screens/home/WelcomeStageBackground';

type Props = { children: React.ReactNode };
type State = { failed: boolean; attempt: number };

/**
 * Ошибка при отрисовке любого экрана без этой границы закрывала приложение целиком.
 * Здесь показываем экран «Что-то пошло не так» и перемонтируем UI по кнопке.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    trackReleaseError('js_render_error', error, {
      componentStack: String(info?.componentStack || '').slice(0, 400),
    });
  }

  private retry = () => {
    this.setState((prev) => ({ failed: false, attempt: prev.attempt + 1 }));
  };

  render() {
    if (!this.state.failed) {
      return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    }
    const lang = useLang.getState().lang;
    return (
      <View style={styles.root}>
        {/* Новая сцена: бирюза у краёв → серый «Поиска», как у сплэша. */}
        <WelcomeStageBackground palette="teal" />
        <Text style={styles.title}>{t('errorBoundaryTitle', lang)}</Text>
        <Text style={styles.text}>{t('errorBoundaryText', lang)}</Text>
        <Pressable
          onPress={this.retry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>{t('errorBoundaryRetry', lang)}</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: HOME_NAV_BG,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 10,
  },
  text: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 360,
    marginBottom: 24,
  },
  button: {
    minHeight: 48,
    paddingHorizontal: 28,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    // Светлая бирюза, как главные кнопки модалок и «Переслать» в чате.
    backgroundColor: `${WELCOME_POPUP_ACCENT}24`,
    borderWidth: 1,
    borderColor: `${WELCOME_POPUP_ACCENT}73`,
  },
  buttonPressed: {
    backgroundColor: `${WELCOME_POPUP_ACCENT}38`,
  },
  buttonText: {
    color: WELCOME_POPUP_ACCENT,
    fontSize: 16,
    fontWeight: '600',
  },
});
