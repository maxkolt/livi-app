import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import AwayPlaceholder from './AwayPlaceholder';
import { HoldPauseIcon } from './VideoChat/shared/HoldPauseIcon';
import { t, type Lang } from '../utils/i18n';

type Mode = 'away' | 'busy';

type Props = {
  lang: Lang;
  mode: Mode;
};

/** Заглушка на видео партнёра: «Отошёл» (камера) или «Звонок на удержании» (сторонний звонок). */
export default function PartnerCallStatusOverlay({ lang, mode }: Props) {
  const label =
    mode === 'busy'
      ? t('partnerCallOnHold', lang)
      : t('away', lang);
  return (
    <View style={[styles.wrap, mode === 'busy' && styles.wrapBusy]}>
      {mode === 'away' ? <AwayPlaceholder /> : null}
      {mode === 'busy' ? (
        <View style={styles.busyRow}>
          <View style={styles.busyIcon}>
            <HoldPauseIcon size={20} />
          </View>
          <Text style={[styles.label, styles.labelBusy]}>{label}</Text>
        </View>
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  wrapBusy: {
    justifyContent: 'flex-start',
    paddingTop: '38%',
    backgroundColor: 'transparent',
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  busyIcon: {
    marginRight: 6,
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
    marginTop: 0,
    fontWeight: '500',
    fontSize: 14,
    color: 'rgba(255,255,255,0.92)',
  },
});
