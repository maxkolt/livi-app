import React, { memo, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AdaptiveText from './AdaptiveText';
import type { Lang } from '../utils/i18n';
import { appReviewCopy } from '../utils/appReviewCopy';
import { openAppReview } from '../utils/appReview';
import { UI_ACCENT, UI_ACCENT_SOFT, WELCOME_HEADER_TITLE, WELCOME_MUTED_TEXT } from '../screens/home/constants';

/** Permanent, voluntary entry inside About; independent of the automatic Google quota. */
function AppReviewCard({ lang }: { lang: Lang }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const opening = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const copy = appReviewCopy(lang);
  if (Platform.OS !== 'android') return null;

  const open = async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const opened = await openAppReview();
      if (mounted.current) setFailed(!opened);
    } finally {
      opening.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <View testID="about-app-review" style={styles.card}>
      <View style={styles.heading}>
        <View style={styles.icon} accessible={false}>
          <Ionicons name="star-outline" size={22} color={UI_ACCENT} />
        </View>
        <AdaptiveText style={styles.title} accessibilityRole="header">{copy.title}</AdaptiveText>
      </View>
      <AdaptiveText style={styles.body}>{copy.body}</AdaptiveText>
      <Pressable
        testID="about-app-review-open"
        accessibilityRole="button"
        accessibilityLabel={`${copy.action}, Google Play`}
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={() => { void open(); }}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
      >
        <AdaptiveText style={styles.buttonText}>{copy.action}</AdaptiveText>
        <Ionicons name="open-outline" size={18} color={UI_ACCENT} accessible={false} />
      </Pressable>
      {failed ? <AdaptiveText accessibilityLiveRegion="polite" style={styles.error}>{copy.error}</AdaptiveText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 14, backgroundColor: UI_ACCENT_SOFT, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: WELCOME_HEADER_TITLE, fontSize: 16, fontWeight: '600' },
  body: { color: WELCOME_MUTED_TEXT, fontSize: 14, lineHeight: 21 },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(98,176,216,0.22)', backgroundColor: UI_ACCENT_SOFT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  buttonPressed: { opacity: 0.65 },
  buttonText: { color: UI_ACCENT, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  error: { color: WELCOME_MUTED_TEXT, fontSize: 13, lineHeight: 19 },
});

export default memo(AppReviewCard);
