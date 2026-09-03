import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { t } from '../../../utils/i18n';
import { useLang } from '../../../store/lang';
import { styles } from '../styles';
import {
  WelcomeOverlayCard,
  WelcomeOverlayDim,
  WelcomeOverlayPill,
} from '../WelcomeOverlayChrome';

export function useLiviConfirm() {
  const [state, setState] = useState<{
    visible: boolean;
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    resolve?: (v: boolean) => void;
  }>({ visible: false, title: '' });
  const lang = useLang((s) => s.lang);

  const ask = useCallback((opts: { title: string; message?: string; confirmText?: string; cancelText?: string }) =>
    new Promise<boolean>((resolve) => {
      setState({
        visible: true,
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText || t('ok', lang),
        cancelText: opts.cancelText || t('cancel', lang),
        resolve,
      });
    }), [lang]);
  const onCancel = useCallback(() => { state.resolve?.(false); setState((s) => ({ ...s, visible: false })); }, [state]);
  const onOk = useCallback(() => { state.resolve?.(true); setState((s) => ({ ...s, visible: false })); }, [state]);

  const view = state.visible ? (
    <View style={styles.overlayModal}>
      <WelcomeOverlayDim strong />
      <WelcomeOverlayCard opaque>
        <Text style={styles.confirmTitle}>{state.title}</Text>
        {!!state.message && <Text style={styles.confirmMsg}>{state.message}</Text>}
        <View style={styles.confirmBtns}>
          <WelcomeOverlayPill
            label={state.cancelText || t('cancel', lang)}
            onPress={onCancel}
            variant="secondary"
            style={{ flex: 1 }}
          />
          <WelcomeOverlayPill
            label={state.confirmText || t('ok', lang)}
            onPress={onOk}
            variant="danger"
            style={{ flex: 1 }}
          />
        </View>
      </WelcomeOverlayCard>
    </View>
  ) : null;

  return { askConfirm: ask, ConfirmView: view };
}
