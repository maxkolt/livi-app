/**
 * Диалог приложения в одном виде — как окно удаления сообщения в чате:
 * карточка, заголовок и текст, под чертой — своё содержимое и полоса кнопок.
 * Не влезает по высоте (landscape, крупный системный шрифт) — содержимое
 * прокручивается, кнопки остаются на месте.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import FitText from './FitText';
import { AppOverlay } from './AppOverlay';
import { useModalLayout } from '../utils/modalLayout';
import { DarkPalette } from '../theme/ThemeProvider';
import { useNickDigitalFont } from '../screens/home/brandFont';
import { UI_ACCENT, UI_SURFACE_RAISED, WELCOME_HEADER_TITLE } from '../screens/home/constants';

export type AppDialogActionVariant = 'cancel' | 'primary' | 'danger';

export type AppDialogAction = {
  label: string;
  onPress: () => void;
  /** cancel — нейтральная; primary — главное действие (голубая); danger — удаление. */
  variant?: AppDialogActionVariant;
  disabled?: boolean;
  /** Идёт запрос — вместо подписи индикатор, нажатия не принимаются. */
  busy?: boolean;
};

export type AppDialogProps = {
  title?: string;
  message?: string;
  /** Значок слева от заголовка. */
  icon?: React.ReactNode;
  /** Своё содержимое под чертой (поля, списки, переключатели). */
  children?: React.ReactNode;
  actions?: AppDialogAction[];
  /**
   * false — содержимое прокручивает себя само (длинный список со своим ScrollView):
   * тогда диалог его не оборачивает, а только ужимает по высоте.
   */
  scrollable?: boolean;
  /** Ширина диалога, если стандартной мало (сетка фото). */
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
};

const TITLE_COLOR = 'rgba(230, 225, 229, 1)';
const MESSAGE_COLOR = 'rgba(255,255,255,0.55)';
const RIM = 'rgba(255,255,255,0.10)';
const DANGER = '255, 90, 103';
const ACCENT = '98, 176, 216';

export function AppDialog({
  title,
  message,
  icon,
  children,
  actions = [],
  scrollable = true,
  maxWidth,
  style,
}: AppDialogProps) {
  const layout = useModalLayout();
  const header =
    title || message ? (
      <View style={styles.header}>
        {title ? (
          <View style={styles.titleRow}>
            {icon ? <View style={styles.icon}>{icon}</View> : null}
            <Text style={styles.title}>{title}</Text>
          </View>
        ) : null}
        {message ? <Text style={[styles.message, !title && { marginTop: 0 }]}>{message}</Text> : null}
      </View>
    ) : null;
  const body = (
    <>
      {header}
      {header && children ? <View style={styles.divider} /> : null}
      {children}
    </>
  );

  return (
    <View
      style={[
        styles.card,
        { maxWidth: maxWidth ?? layout.dialogMaxWidth, maxHeight: layout.maxCardHeight },
        style,
      ]}
    >
      {scrollable ? (
        <ScrollView
          style={styles.shrink}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
          keyboardShouldPersistTaps="handled"
        >
          {body}
        </ScrollView>
      ) : (
        <View style={styles.shrink}>{body}</View>
      )}
      {actions.length > 0 ? (
        <>
          {!children ? <View style={styles.divider} /> : null}
          <View style={[styles.actions, actions.length > 2 && styles.actionsColumn]}>
            {actions.map((action, i) => (
              <AppDialogButton key={`${action.label}-${i}`} {...action} stretch={actions.length <= 2} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

export function AppDialogButton({
  label,
  onPress,
  variant = 'cancel',
  disabled,
  busy,
  stretch = true,
}: AppDialogAction & { stretch?: boolean }) {
  const inactive = !!disabled || !!busy;
  // Главное действие подписано как ник над радаром: Exo 2 Medium, тот же цвет и разрядка.
  const nickFont = useNickDigitalFont();
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        stretch && styles.buttonStretch,
        variant === 'danger'
          ? [styles.buttonDanger, pressed && styles.buttonDangerPressed]
          : variant === 'primary'
            ? [styles.buttonPrimary, pressed && styles.buttonPrimaryPressed]
            : [styles.buttonCancel, pressed && styles.buttonCancelPressed],
        pressed && variant !== 'cancel' && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={WELCOME_HEADER_TITLE} />
      ) : (
        <FitText
          style={[
            styles.buttonLabel,
            variant === 'cancel' && styles.buttonLabelCancel,
            variant === 'primary' && [
              styles.buttonLabelPrimary,
              { fontFamily: nickFont.fontFamily, fontWeight: nickFont.fontWeight },
            ],
          ]}
        >
          {label}
        </FitText>
      )}
    </Pressable>
  );
}

/** Модалка с диалогом: фон и появление — AppOverlay, карточка — AppDialog. */
export function AppDialogModal({
  visible,
  onRequestClose,
  dismissOnBackdrop = true,
  ...dialog
}: AppDialogProps & {
  visible: boolean;
  onRequestClose?: () => void;
  dismissOnBackdrop?: boolean;
}) {
  return (
    <AppOverlay visible={visible} onRequestClose={onRequestClose} dismissOnBackdrop={dismissOnBackdrop}>
      <AppDialog {...dialog} />
    </AppOverlay>
  );
}

/** Строка-вариант внутри диалога (причина жалобы, язык, пункт меню). */
export const appDialogStyles = StyleSheet.create({
  section: {
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  optionPressed: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  optionText: {
    flex: 1,
    color: TITLE_COLOR,
    fontSize: 15,
  },
  input: {
    color: TITLE_COLOR,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  error: {
    color: `rgb(${DANGER})`,
    fontSize: 13,
    lineHeight: 17,
  },
});

export const APP_DIALOG_TITLE_COLOR = TITLE_COLOR;
export const APP_DIALOG_MESSAGE_COLOR = MESSAGE_COLOR;
export const APP_DIALOG_ACCENT = UI_ACCENT;

const styles = StyleSheet.create({
  card: {
    width: '100%',
    flexShrink: 1,
    borderRadius: 18,
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: RIM,
    overflow: 'hidden',
  },
  shrink: {
    flexShrink: 1,
  },
  scrollContent: {
    flexGrow: 0,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: 10,
  },
  title: {
    flex: 1,
    color: TITLE_COLOR,
    fontSize: 18,
    fontWeight: '700',
  },
  message: {
    marginTop: 8,
    color: MESSAGE_COLOR,
    fontSize: 14,
    lineHeight: 18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: RIM,
  },
  actions: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
  },
  actionsColumn: {
    flexDirection: 'column',
  },
  button: {
    minHeight: 40,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonStretch: {
    flex: 1,
  },
  buttonCancel: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  buttonCancelPressed: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  // Главное действие — та же форма, что «Удалить», в голубом: заметно, но не кричит.
  buttonPrimary: {
    backgroundColor: `rgba(${ACCENT}, 0.24)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT}, 0.80)`,
  },
  buttonPrimaryPressed: {
    backgroundColor: `rgba(${ACCENT}, 0.34)`,
  },
  buttonDanger: {
    backgroundColor: `rgba(${DANGER}, 0.16)`,
    borderWidth: 1,
    borderColor: `rgba(${DANGER}, 0.72)`,
  },
  buttonDangerPressed: {
    backgroundColor: `rgba(${DANGER}, 0.24)`,
  },
  buttonPressed: {
    transform: [{ scale: 0.99 }],
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonLabel: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 15,
    fontWeight: '600',
  },
  buttonLabelCancel: {
    color: DarkPalette.titan,
  },
  buttonLabelPrimary: {
    letterSpacing: 0.6,
  },
});
