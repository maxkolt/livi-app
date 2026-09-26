import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LIVI, t, type Lang } from '../../utils/i18n';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER } from '../../utils/accessibilityTypography';
import { WELCOME_NAV_ACTIVE_ACCENT } from '../home/constants';
import {
  changeE2eBackupPassword,
  disableE2e,
  enableE2eAgain,
  getE2eStatus,
  getPeerPublicKey,
  onPeerE2eUpdated,
  markE2eSetupPromptSeen,
  onE2eStatus,
  onPeerKeyChanged,
  resetE2e,
  restoreE2e,
  setupE2e,
  wasE2eSetupPromptSeen,
  type E2eStatus,
} from '../../sockets/modules/e2e';
import { isAcceptableBackupPassword } from '../../sockets/modules/e2eCrypto';

export type E2eModalMode = 'setup' | 'restore' | 'reset' | 'change' | 'disable' | 'enable';
type Mode = E2eModalMode;
type PasswordMode = 'setup' | 'restore' | 'reset' | 'change';

export type E2eMenuAction = { mode: E2eModalMode; labelKey: string; tone: 'accent' | 'plain' };

/** Пункты меню чата для текущего состояния шифрования (пусто — пока состояние неизвестно). */
export function e2eMenuActions(status: E2eStatus, hasLocalKey: boolean): E2eMenuAction[] {
  if (status === 'needs_setup') return [{ mode: 'setup', labelKey: 'e2eMenuEnable', tone: 'accent' }];
  if (status === 'needs_restore') return [{ mode: 'restore', labelKey: 'e2eMenuRestore', tone: 'accent' }];
  if (status === 'ready') {
    return [
      { mode: 'change', labelKey: 'e2eMenuChangePassword', tone: 'accent' },
      { mode: 'disable', labelKey: 'e2eMenuDisable', tone: 'accent' },
    ];
  }
  if (status === 'disabled') {
    // Ключ на устройстве есть — включаем без пароля; нет (переустановка) — сначала восстановить.
    return hasLocalKey
      ? [{ mode: 'enable', labelKey: 'e2eMenuEnableAgain', tone: 'accent' }]
      : [{ mode: 'restore', labelKey: 'e2eMenuRestore', tone: 'accent' }];
  }
  return [];
}

/**
 * Переписка с этим собеседником шифруется: у меня шифрование включено и у него
 * опубликован ключ. Обновляется, когда кто-то из двоих включает или отключает его.
 */
export function usePeerChatEncrypted(peerId: string, status: E2eStatus): boolean {
  const [peerHasKey, setPeerHasKey] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(
    () =>
      onPeerE2eUpdated((changed) => {
        if (changed === peerId) setRefreshTick((n) => n + 1);
      }),
    [peerId],
  );
  useEffect(() => {
    if (status !== 'ready' || !peerId) {
      setPeerHasKey(false);
      return;
    }
    let cancelled = false;
    getPeerPublicKey(peerId, { force: refreshTick > 0 })
      .then((pk) => {
        if (!cancelled) setPeerHasKey(!!pk);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [peerId, status, refreshTick]);
  return status === 'ready' && peerHasKey;
}

/** Состояние шифрования для экрана (меню чата). */
export function useE2eStatus(): E2eStatus {
  const [status, setStatus] = useState<E2eStatus>(() => getE2eStatus());
  useEffect(() => onE2eStatus(setStatus), []);
  return status;
}

/**
 * Над полем ввода чата. Предложение включить шифрование — один раз, при первом
 * открытии чата (дальше оно в меню справа вверху). Требование восстановить ключ
 * после переустановки остаётся, пока ключ не восстановлен: без него отправка
 * заблокирована. Плюс уведомление о смене ключа собеседника.
 */
export function E2eChatBanner({
  lang,
  peerId,
  requestedMode,
  onRequestedModeHandled,
}: {
  lang: Lang;
  peerId: string;
  /** Открыть окно из меню чата. */
  requestedMode?: E2eModalMode | null;
  onRequestedModeHandled?: () => void;
}) {
  const status = useE2eStatus();
  const [showSetupPrompt, setShowSetupPrompt] = useState(false);
  const [peerKeyChanged, setPeerKeyChanged] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    if (!requestedMode) return;
    setMode(requestedMode);
    onRequestedModeHandled?.();
  }, [requestedMode, onRequestedModeHandled]);

  // Первый раз, когда пользователь без шифрования открыл чат: показываем и запоминаем.
  useEffect(() => {
    if (status !== 'needs_setup') {
      setShowSetupPrompt(false);
      return;
    }
    let cancelled = false;
    void wasE2eSetupPromptSeen().then((seen) => {
      if (cancelled || seen) return;
      setShowSetupPrompt(true);
      void markE2eSetupPromptSeen();
    });
    return () => {
      cancelled = true;
    };
  }, [status]);
  useEffect(
    () =>
      onPeerKeyChanged((changedPeerId) => {
        if (changedPeerId === peerId) setPeerKeyChanged(true);
      }),
    [peerId],
  );

  let banner: React.ReactNode = null;
  if (status === 'needs_restore') {
    banner = (
      <TouchableOpacity style={styles.banner} onPress={() => setMode('restore')} accessibilityRole="button">
        <Text style={styles.bannerText}>{t('e2eBannerRestore', lang)}</Text>
      </TouchableOpacity>
    );
  } else if (status === 'needs_setup' && showSetupPrompt) {
    banner = (
      <View style={styles.banner}>
        <TouchableOpacity style={{ flex: 1 }} onPress={() => setMode('setup')} accessibilityRole="button">
          <Text style={styles.bannerText}>{t('e2eBannerSetup', lang)}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowSetupPrompt(false)} hitSlop={10} accessibilityLabel={t('e2eLater', lang)}>
          <Text style={styles.close}>×</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (peerKeyChanged) {
    banner = (
      <View style={styles.banner}>
        <Text style={[styles.bannerText, { flex: 1 }]}>{t('e2ePeerKeyChanged', lang)}</Text>
        <TouchableOpacity onPress={() => setPeerKeyChanged(false)} hitSlop={10}>
          <Text style={styles.close}>×</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      {banner}
      {mode === 'disable' || mode === 'enable' ? (
        <E2eConfirmModal lang={lang} mode={mode} onClose={() => setMode(null)} />
      ) : mode ? (
        <E2ePasswordModal lang={lang} mode={mode} onModeChange={setMode} onClose={() => setMode(null)} />
      ) : null}
    </>
  );
}

/** Отключить / включить снова — без пароля, только подтверждение. */
function E2eConfirmModal({ lang, mode, onClose }: { lang: Lang; mode: 'disable' | 'enable'; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'disable' ? await disableE2e() : await enableE2eAgain();
      if (r.ok) onClose();
      else setError(t('e2eNetworkError', lang));
    } catch {
      setError(t('e2eNetworkError', lang));
    } finally {
      setBusy(false);
    }
  }, [busy, mode, lang, onClose]);
  const disabling = mode === 'disable';
  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? () => {} : onClose}>
      <View style={styles.overlay}>
        <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
        <View style={styles.card}>
          <Text style={styles.title}>{t(disabling ? 'e2eDisableTitle' : 'e2eEnableAgainTitle', lang)}</Text>
          <Text style={styles.text}>{t(disabling ? 'e2eDisableText' : 'e2eEnableAgainText', lang)}</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={onClose} disabled={busy}>
              <Text style={styles.btnText}>{t('e2eLater', lang)}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, disabling ? styles.btnDanger : styles.btnPrimary]}
              onPress={confirm}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={LIVI.white} size="small" />
              ) : (
                <Text style={styles.btnText}>{t(disabling ? 'e2eDisableConfirm' : 'e2eEnable', lang)}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function E2ePasswordModal({
  lang,
  mode,
  onModeChange,
  onClose,
}: {
  lang: Lang;
  mode: PasswordMode;
  onModeChange: (m: Mode) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsRepeat = mode !== 'restore';
  const passwordRef = useRef<TextInput>(null);
  const repeatRef = useRef<TextInput>(null);
  // Окно поднимаем над клавиатурой: иначе второе поле и кнопки уходят под неё,
  // а «Назад», чтобы её убрать, закрывает окно вместе с введённым паролем.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKeyboardHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // autoFocus в Android-модалке не открывает клавиатуру — фокусируем после появления окна.
  useEffect(() => {
    const id = setTimeout(() => passwordRef.current?.focus(), 250);
    return () => clearTimeout(id);
  }, [mode]);

  useEffect(() => {
    setPassword('');
    setRepeat('');
    setError(null);
  }, [mode]);

  const submit = useCallback(async () => {
    if (busy) return;
    if (needsRepeat) {
      if (!isAcceptableBackupPassword(password)) return setError(t('e2ePasswordTooShort', lang));
      if (password !== repeat) return setError(t('e2ePasswordMismatch', lang));
    } else if (!password) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const action =
        mode === 'setup'
          ? setupE2e
          : mode === 'restore'
            ? restoreE2e
            : mode === 'change'
              ? changeE2eBackupPassword
              : resetE2e;
      const r = await action(password);
      if (r.ok) {
        onClose();
        return;
      }
      setError(
        r.error === 'wrong_password'
          ? t('e2eWrongPassword', lang)
          : r.error === 'rate_limited'
            ? t('e2eTooManyAttempts', lang)
            : t('e2eNetworkError', lang),
      );
    } catch {
      setError(t('e2eNetworkError', lang));
    } finally {
      setBusy(false);
    }
  }, [busy, needsRepeat, password, repeat, mode, lang, onClose]);

  const title = { setup: 'e2eSetupTitle', restore: 'e2eRestoreTitle', reset: 'e2eResetTitle', change: 'e2eChangeTitle' }[mode];
  const text = { setup: 'e2eSetupText', restore: 'e2eRestoreText', reset: 'e2eResetText', change: 'e2eChangeText' }[mode];
  const action = { setup: 'e2eEnable', restore: 'e2eRestore', reset: 'e2eEnable', change: 'e2eSave' }[mode];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? () => {} : onClose}>
      <View style={[styles.overlay, { paddingBottom: 20 + keyboardHeight }]}>
        <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
        <View style={styles.card}>
          <Text style={styles.title}>{t(title, lang)}</Text>
          <Text style={styles.text}>{t(text, lang)}</Text>
          <TextInput
            ref={passwordRef}
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder={t('e2ePasswordPlaceholder', lang)}
            placeholderTextColor={LIVI.titan}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxFontSizeMultiplier={APP_INPUT_MAX_FONT_SIZE_MULTIPLIER}
            textContentType={needsRepeat ? 'newPassword' : 'password'}
            editable={!busy}
            returnKeyType={needsRepeat ? 'next' : 'done'}
            blurOnSubmit={!needsRepeat}
            onSubmitEditing={() => (needsRepeat ? repeatRef.current?.focus() : void submit())}
          />
          {needsRepeat ? (
            <TextInput
              ref={repeatRef}
              style={styles.input}
              value={repeat}
              onChangeText={setRepeat}
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
              placeholder={t('e2ePasswordRepeat', lang)}
              placeholderTextColor={LIVI.titan}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              maxFontSizeMultiplier={APP_INPUT_MAX_FONT_SIZE_MULTIPLIER}
              textContentType="newPassword"
              editable={!busy}
            />
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={onClose} disabled={busy}>
              <Text style={styles.btnText}>{t('e2eLater', lang)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={submit} disabled={busy}>
              {busy ? (
                <View style={styles.busyRow}>
                  <ActivityIndicator color={LIVI.white} size="small" />
                  <Text style={[styles.btnText, { marginLeft: 6 }]}>{t('e2eWorking', lang)}</Text>
                </View>
              ) : (
                <Text style={styles.btnText}>{t(action, lang)}</Text>
              )}
            </TouchableOpacity>
          </View>
          {mode === 'restore' ? (
            <TouchableOpacity onPress={() => onModeChange('reset')} disabled={busy} style={styles.link}>
              <Text style={styles.linkText}>{t('e2eForgotPassword', lang)}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 10,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: WELCOME_NAV_ACTIVE_ACCENT.solid15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_NAV_ACTIVE_ACCENT.solid30,
  },
  bannerText: { color: LIVI.text, fontSize: 13, lineHeight: 17 },
  close: { color: LIVI.titan, fontSize: 20, lineHeight: 20, marginLeft: 10 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 18,
    padding: 20,
    backgroundColor: LIVI.bg,
  },
  title: { color: LIVI.white, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  text: { color: LIVI.text, fontSize: 14, lineHeight: 19, marginBottom: 14 },
  input: {
    color: LIVI.white,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: LIVI.surface,
    marginBottom: 10,
  },
  error: { color: LIVI.red, fontSize: 13, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 12, marginTop: 6 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: WELCOME_NAV_ACTIVE_ACCENT.solid },
  btnSecondary: { backgroundColor: 'rgba(138, 143, 153, 0.25)' },
  btnDanger: { backgroundColor: 'rgba(255, 90, 103, 0.35)' },
  btnText: { color: LIVI.white, fontSize: 15, fontWeight: '600' },
  busyRow: { flexDirection: 'row', alignItems: 'center' },
  link: { alignSelf: 'center', marginTop: 14, padding: 4 },
  linkText: { color: LIVI.titan, fontSize: 13, textDecorationLine: 'underline' },
});
