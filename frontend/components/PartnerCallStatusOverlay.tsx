import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import AwayPlaceholder from './AwayPlaceholder';
import { t, type Lang } from '../utils/i18n';

type Mode = 'away' | 'busy';

type Props = {
  lang: Lang;
  mode: Mode;
};

/** Заглушка на видео партнёра: «Отошёл» (камера) или «Занято...» (сторонний звонок). */
export default function PartnerCallStatusOverlay({ lang, mode }: Props) {
  const label =
    mode === 'busy'
      ? (t('partnerBusyEllipsis', lang) || `${t('busy', lang)}...`)
      : t('away', lang);
  return (
    <View style={styles.wrap}>
      <AwayPlaceholder />
      <Text style={[styles.label, mode === 'busy' && styles.labelBusy]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 12,
    color: 'rgba(255,255,255,0.92)',
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  labelBusy: {
    fontWeight: '400',
    fontSize: 16,
    color: 'rgba(255,255,255,0.88)',
  },
});
