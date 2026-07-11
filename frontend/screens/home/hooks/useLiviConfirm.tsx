import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Surface } from 'react-native-paper';
import { t } from '../../../utils/i18n';
import { useLang } from '../../../store/lang';
import { LIVI } from '../constants';
import { styles } from '../styles';

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
      <BlurView intensity={Platform.OS === 'android' ? 100 : 85} tint="dark" style={StyleSheet.absoluteFill} />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.35)' },
        ]}
      />
      <Surface style={styles.confirmCard}>
        <Text style={styles.confirmTitle}>{state.title}</Text>
        {!!state.message && <Text style={styles.confirmMsg}>{state.message}</Text>}
        <View style={styles.confirmBtns}>
          <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: LIVI.glass }]} onPress={onCancel}>
            <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>{state.cancelText}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: LIVI.red }]} onPress={onOk}>
            <Text style={[styles.confirmBtnText, { color: LIVI.white }]}>{state.confirmText}</Text>
          </TouchableOpacity>
        </View>
      </Surface>
    </View>
  ) : null;

  return { askConfirm: ask, ConfirmView: view };
}
