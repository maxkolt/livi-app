import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AdaptiveText from '../../components/AdaptiveText';
import { cosmeticNameKey, setActiveCosmetic, useCosmetics, type CosmeticKind } from '../../utils/cosmetics';
import { t, type Lang } from '../../utils/i18n';
import { useLang } from '../../store/lang';
import {
  LIVI,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
} from './constants';
import { CosmeticFramePreview } from '../../components/frames/CosmeticFramePreview';
import { getCosmeticBackground } from '../../utils/cosmeticCatalog';

/** Название купленной рамки или фона; неизвестный id показываем как есть. */
function cosmeticName(itemId: string, lang: Lang): string {
  const key = cosmeticNameKey(itemId);
  const name = t(key, lang);
  return name === key ? itemId : name;
}

function FramePreview({ itemId }: { itemId: string }) {
  return (
    <CosmeticFramePreview
      itemId={itemId}
      size={48}
      ringWidth={3}
      fallback={<View style={styles.emptyFrame} />}
    />
  );
}

function BackgroundPreview({ itemId }: { itemId: string }) {
  const source = getCosmeticBackground(itemId)?.source;
  if (!source) return <View style={styles.emptyBackground} />;
  return (
    <View style={styles.backgroundSwatch}>
      <ExpoImage source={source} style={StyleSheet.absoluteFillObject} contentFit="cover" cachePolicy="memory-disk" />
      <View style={styles.backgroundPreviewBorder} pointerEvents="none" />
    </View>
  );
}

function EmptyPurchase({ kind, lang }: { kind: CosmeticKind; lang: Lang }) {
  return (
    <View style={styles.emptyRow}>
      <View style={kind === 'frame' ? styles.emptyFrame : styles.emptyBackground} />
      <View style={styles.copy}>
        <AdaptiveText style={styles.emptyTitle}>
          {t(kind === 'frame' ? 'purchasesNoFrames' : 'purchasesNoBackgrounds', lang)}
        </AdaptiveText>
        <AdaptiveText style={styles.emptyHint}>{t('purchasesEmptyHint', lang)}</AdaptiveText>
      </View>
    </View>
  );
}

export function PurchasesManagementPanel() {
  const lang = useLang((state) => state.lang);
  const cosmetics = useCosmetics();
  const [busyKey, setBusyKey] = useState('');

  const toggle = async (kind: CosmeticKind, itemId: string, active: boolean) => {
    const key = `${kind}:${itemId}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      await setActiveCosmetic(kind, active ? '' : itemId);
    } finally {
      setBusyKey('');
    }
  };

  const renderItem = (kind: CosmeticKind, itemId: string) => {
    const active = kind === 'frame' ? cosmetics.activeFrameId === itemId : cosmetics.activeBackgroundId === itemId;
    return (
      <View key={`${kind}:${itemId}`} style={styles.itemRow}>
        {kind === 'frame' ? <FramePreview itemId={itemId} /> : <BackgroundPreview itemId={itemId} />}
        <AdaptiveText style={styles.itemLabel} numberOfLines={1}>
          {cosmeticName(itemId, lang)}
        </AdaptiveText>
        <Pressable
          onPress={() => void toggle(kind, itemId, active)}
          disabled={!!busyKey}
          style={({ pressed }) => [styles.action, active && styles.actionActive, pressed && styles.actionPressed]}
        >
          <AdaptiveText style={[styles.actionText, active && styles.actionTextActive]}>
            {busyKey === `${kind}:${itemId}` ? '…' : t(active ? 'purchasesRemove' : 'purchasesApply', lang)}
          </AdaptiveText>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.section}>
        <AdaptiveText style={styles.sectionTitle}>{t('storeAvatarFrames', lang)}</AdaptiveText>
        <View style={styles.card}>
          {cosmetics.purchasedFrameIds.length
            ? cosmetics.purchasedFrameIds.map((id) => renderItem('frame', id))
            : <EmptyPurchase kind="frame" lang={lang} />}
        </View>
      </View>
      <View style={styles.section}>
        <AdaptiveText style={styles.sectionTitle}>{t('storeChatBackgrounds', lang)}</AdaptiveText>
        <View style={styles.card}>
          {cosmetics.purchasedBackgroundIds.length
            ? cosmetics.purchasedBackgroundIds.map((id) => renderItem('background', id))
            : <EmptyPurchase kind="background" lang={lang} />}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, gap: 18 },
  section: { gap: 8 },
  sectionTitle: { color: WELCOME_HEADER_TITLE, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginLeft: 4 },
  card: {
    borderRadius: 16,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    overflow: 'hidden',
  },
  emptyRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12 },
  emptyFrame: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: 'rgba(180,186,196,0.42)',
    backgroundColor: 'rgba(180,186,196,0.08)',
  },
  emptyBackground: {
    width: 52,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(180,186,196,0.38)',
    backgroundColor: 'rgba(180,186,196,0.08)',
  },
  copy: { flex: 1, minWidth: 0 },
  emptyTitle: { color: LIVI.text, fontSize: 14, fontWeight: '600' },
  emptyHint: { marginTop: 2, color: WELCOME_MUTED_TEXT, fontSize: 12 },
  itemRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },
  backgroundSwatch: {
    width: 54,
    height: 38,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111923',
  },
  backgroundPreviewBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(238,229,244,0.72)',
  },
  itemLabel: { flex: 1, minWidth: 0, color: LIVI.text, fontSize: 14, fontWeight: '600' },
  action: {
    minWidth: 86,
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(238,229,244,0.55)',
    backgroundColor: 'rgba(238,229,244,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionActive: { borderColor: 'rgba(176,186,200,0.38)', backgroundColor: 'rgba(176,186,200,0.06)' },
  actionPressed: { opacity: 0.72 },
  actionText: { color: '#EDE6F1', fontSize: 12, fontWeight: '700' },
  actionTextActive: { color: WELCOME_MUTED_TEXT },
});
