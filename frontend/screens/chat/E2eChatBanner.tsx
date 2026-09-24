import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LIVI, t, type Lang } from '../../utils/i18n';
import {
  getE2eStatus,
  onE2eStatus,
  onPeerKeyChanged,
  resetE2e,
  restoreE2e,
  setupE2e,
  type E2eStatus,
} from '../../sockets/modules/e2e';
import { isAcceptableBackupPassword } from '../../sockets/modules/e2eCrypto';

type Mode = 'setup' | 'restore' | 'reset';

/** Плашку «включите шифрование» можно скрыть до перезапуска; «восстановите ключ» — нельзя. */
let setupBannerDismissed = false;

/**
 * Над полем ввода чата: предложение включить сквозное шифрование, требование
 * восстановить ключ после переустановки и уведомление о смене ключа собеседника.
 */
export function E2eChatBanner({ lang, peerId }: { lang: Lang; peerId: string }) {
  const [status, setStatus] = useState<E2eStatus>(() => getE2eStatus());
  const [dismissed, setDismissed] = useState(setupBannerDismissed);
  const [peerKeyChanged, setPeerKeyChanged] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => onE2eStatus(setStatus), []);
  useEffect(
    () =>
      onPeerKeyChanged((changedPeerId) => {
        if (changedPeerId === peerId) setPeerKeyChanged(true);
      }),
    [peerId],
  );

  const dismissSetup = useCallback(() => {
    setupBannerDismissed = true;
    setDismissed(true);
  }, []);

  let banner: React.ReactNode = null;
  if (status === 'needs_restore') {
    banner = (
      <TouchableOpacity style={styles.banner} onPress={() => setMode('restore')} accessibilityRole="button">
        <Text style={styles.bannerText}>{t('e2eBannerRestore', lang)}</Text>
      </TouchableOpacity>
    );
  } else if (status === 'needs_setup' && !dismissed) {
    banner = (
      <View style={styles.banner}>
        <TouchableOpacity style={{ flex: 1 }} onPress={() => setMode('setup')} accessibilityRole="button">
          <Text style={styles.bannerText}>{t('e2eBannerSetup', lang)}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={dismissSetup} hitSlop={10} accessibilityLabel={t('e2eLater', lang)}>
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
      {mode ? <E2ePasswordModal lang={lang} mode={mode} onModeChange={setMode} onClose={() => setMode(null)} /> : null}
    </>
  );
}

function E2ePasswordModal({
  lang,
  mode,
  onModeChange,
  onClose,
}: {
  lang: Lang;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsRepeat = mode !== 'restore';

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
      const action = mode === 'setup' ? setupE2e : mode === 'restore' ? restoreE2e : resetE2e;
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

  const title = mode === 'setup' ? 'e2eSetupTitle' : mode === 'restore' ? 'e2eRestoreTitle' : 'e2eResetTitle';
  const text = mode === 'setup' ? 'e2eSetupText' : mode === 'restore' ? 'e2eRestoreText' : 'e2eResetText';
  const action = mode === 'restore' ? 'e2eRestore' : 'e2eEnable';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? () => {} : onClose}>
      <View style={styles.overlay}>
        <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
        <View style={styles.card}>
          <Text style={styles.title}>{t(title, lang)}</Text>
          <Text style={styles.text}>{t(text, lang)}</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder={t('e2ePasswordPlaceholder', lang)}
            placeholderTextColor={LIVI.titan}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType={needsRepeat ? 'newPassword' : 'password'}
            editable={!busy}
            autoFocus
          />
          {needsRepeat ? (
            <TextInput
              style={styles.input}
              value={repeat}
              onChangeText={setRepeat}
              placeholder={t('e2ePasswordRepeat', lang)}
              placeholderTextColor={LIVI.titan}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
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
    backgroundColor: 'rgba(46, 204, 113, 0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(46, 204, 113, 0.35)',
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
  btnPrimary: { backgroundColor: 'rgba(46, 204, 113, 0.35)' },
  btnSecondary: { backgroundColor: 'rgba(138, 143, 153, 0.25)' },
  btnText: { color: LIVI.white, fontSize: 15, fontWeight: '600' },
  busyRow: { flexDirection: 'row', alignItems: 'center' },
  link: { alignSelf: 'center', marginTop: 14, padding: 4 },
  linkText: { color: LIVI.titan, fontSize: 13, textDecorationLine: 'underline' },
});
