import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LIVI, t, type Lang } from '../../utils/i18n';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER } from '../../utils/accessibilityTypography';
import { WELCOME_NAV_ACTIVE_ACCENT } from '../home/constants';
import { AppDialogModal, appDialogStyles } from '../../components/AppDialog';
import {
  getE2eStatus,
  getPeerPublicKey,
  markE2eChatNoticeSeen,
  peekPeerPublicKey,
  onPeerE2eUpdated,
  onE2eStatus,
  onPeerKeyChanged,
  resetE2e,
  restoreE2e,
  wasE2eChatNoticeSeen,
  type E2eStatus,
} from '../../sockets/modules/e2e';

/**
 * Шифрование включается само у всех и не отключается — ни пароля, ни кнопок в меню.
 * Окна остались только для прежней схемы с паролем: вернуть ключ паролем (restore) или,
 * если пароль забыт, начать заново (reset).
 */
type Mode = 'restore' | 'reset';

/**
 * Переписка с этим собеседником шифруется: у меня шифрование включено и у него
 * опубликован ключ. Обновляется, когда кто-то из двоих включает или отключает его.
 */
export function usePeerChatEncrypted(peerId: string, status: E2eStatus): boolean {
  // Ключ уже известен в этой сессии — сразу верный значок, без перерисовки при открытии чата.
  const [peerHasKey, setPeerHasKey] = useState(() => !!peekPeerPublicKey(peerId));
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
 * Над полем ввода чата. Шифрование включается само, предлагать его не нужно. Остаются:
 * требование восстановить ключ, включённый по паролю (прежняя схема), — пока он не
 * восстановлен, отправка заблокирована; уведомление о смене ключа собеседника; и один раз
 * на собеседника — что пустой чат защищён.
 */
export function E2eChatBanner({
  lang,
  peerId,
  encrypted = false,
  emptyChat = false,
}: {
  lang: Lang;
  peerId: string;
  /** Переписка с собеседником шифруется (ключи есть у обоих). */
  encrypted?: boolean;
  /** Сервер подтвердил, что сообщений ещё не было. */
  emptyChat?: boolean;
}) {
  const status = useE2eStatus();
  const [peerKeyChanged, setPeerKeyChanged] = useState(false);
  const [showChatNotice, setShowChatNotice] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);

  // Первый вход в пустой зашифрованный чат с этим собеседником: показываем и запоминаем.
  // Висит до крестика или выхода из чата, даже если переписка уже началась.
  useEffect(() => {
    if (!encrypted || !emptyChat) return;
    let cancelled = false;
    void wasE2eChatNoticeSeen(peerId).then((seen) => {
      if (cancelled || seen) return;
      setShowChatNotice(true);
      void markE2eChatNoticeSeen(peerId);
    });
    return () => {
      cancelled = true;
    };
  }, [encrypted, emptyChat, peerId]);

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
  } else if (peerKeyChanged) {
    banner = (
      <View style={styles.banner}>
        <Text style={[styles.bannerText, { flex: 1 }]}>{t('e2ePeerKeyChanged', lang)}</Text>
        <TouchableOpacity onPress={() => setPeerKeyChanged(false)} hitSlop={10}>
          <Text style={styles.close}>×</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (showChatNotice && encrypted) {
    banner = (
      <View style={styles.banner}>
        <Text style={[styles.bannerText, { flex: 1 }]}>{t('e2eChatNotice', lang)}</Text>
        <TouchableOpacity onPress={() => setShowChatNotice(false)} hitSlop={10} accessibilityLabel={t('e2eLater', lang)}>
          <Text style={styles.close}>×</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      {banner}
      {mode === 'reset' ? (
        <E2eResetModal lang={lang} onClose={() => setMode(null)} />
      ) : mode === 'restore' ? (
        <E2eRestoreModal lang={lang} onModeChange={setMode} onClose={() => setMode(null)} />
      ) : null}
    </>
  );
}

/**
 * «Не помню пароль» прежней схемы: новый ключ, старая переписка здесь не читается.
 */
function E2eResetModal({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await resetE2e();
      if (r.ok) onClose();
      else setError(t('e2eNetworkError', lang));
    } catch {
      setError(t('e2eNetworkError', lang));
    } finally {
      setBusy(false);
    }
  }, [busy, lang, onClose]);
  return (
    <AppDialogModal
      visible
      // Пока идёт запрос, окно не закрывается ни фоном, ни «Назад».
      onRequestClose={busy ? undefined : onClose}
      dismissOnBackdrop={!busy}
      title={t('e2eSetupTitle', lang)}
      message={t('e2eResetText', lang)}
      actions={[
        { label: t('e2eLater', lang), onPress: onClose, disabled: busy },
        { label: t('e2eEnable', lang), onPress: () => void confirm(), variant: 'primary', busy },
      ]}
    >
      {error ? (
        <View style={appDialogStyles.section}>
          <Text style={appDialogStyles.error}>{error}</Text>
        </View>
      ) : null}
    </AppDialogModal>
  );
}

/** Прежняя схема: вернуть ключ паролем после переустановки — переписка снова читается. */
function E2eRestoreModal({
  lang,
  onModeChange,
  onClose,
}: {
  lang: Lang;
  onModeChange: (m: Mode) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  // Над клавиатурой окно поднимает AppOverlay; фокус — после появления окна, когда оно на месте.
  useEffect(() => {
    const id = setTimeout(() => passwordRef.current?.focus(), 250);
    return () => clearTimeout(id);
  }, []);

  const submit = useCallback(async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await restoreE2e(password);
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
  }, [busy, password, lang, onClose]);

  return (
    <AppDialogModal
      visible
      onRequestClose={busy ? undefined : onClose}
      dismissOnBackdrop={!busy}
      title={t('e2eRestoreTitle', lang)}
      message={t('e2eRestoreText', lang)}
      actions={[
        { label: t('e2eLater', lang), onPress: onClose, disabled: busy },
        { label: t('e2eRestore', lang), onPress: () => void submit(), variant: 'primary', busy },
      ]}
    >
      <View style={[appDialogStyles.section, { gap: 10 }]}>
        <TextInput
          ref={passwordRef}
          style={appDialogStyles.input}
          value={password}
          onChangeText={setPassword}
          placeholder={t('e2ePasswordPlaceholder', lang)}
          placeholderTextColor={LIVI.titan}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          maxFontSizeMultiplier={APP_INPUT_MAX_FONT_SIZE_MULTIPLIER}
          textContentType="password"
          editable={!busy}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
        />
        {error ? <Text style={appDialogStyles.error}>{error}</Text> : null}
        <TouchableOpacity onPress={() => onModeChange('reset')} disabled={busy} style={styles.link}>
          <Text style={styles.linkText}>{t('e2eForgotPassword', lang)}</Text>
        </TouchableOpacity>
      </View>
    </AppDialogModal>
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
  link: { alignSelf: 'center', marginTop: 2, padding: 4 },
  linkText: { color: LIVI.titan, fontSize: 13, textDecorationLine: 'underline' },
});
