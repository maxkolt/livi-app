import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { AppDialogModal } from '../AppDialog';
import { submitCosmeticFeedback, type RewardWallet } from '../../utils/cosmetics';
import { API_BASE } from '../../sockets/modules/constants';
import { t, type Lang } from '../../utils/i18n';
import { formatLiviPoints } from '../../utils/liviRewards';
import { CROWN_GOLD, WELCOME_HEADER_TITLE, WELCOME_MUTED_TEXT, UI_ACCENT, UI_ACCENT_LIGHT, UI_SURFACE, UI_RIM, UI_ACCENT_SOFT } from '../../screens/home/constants';

export function LiviRewardsDialog({ visible, onClose, wallet, userId, lang, targetPrice }: {
  visible: boolean; onClose: () => void; wallet?: RewardWallet; userId?: string; lang: Lang; targetPrice?: number;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingFeedback, setEditingFeedback] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!visible) setEditingFeedback(false);
    const subscription = Keyboard.addListener('keyboardDidHide', () => setEditingFeedback(false));
    return () => subscription.remove();
  }, [visible]);
  const L = (key: string) => t(key, lang);
  const share = async () => {
    if (!userId) return;
    const publicBase = /^https:\/\//.test(API_BASE) ? API_BASE : 'https://api.liviapp.com';
    const link = `${publicBase}/invite/${encodeURIComponent(userId)}`;
    try {
      await Share.share({ message: L('rewardsShareText').replace('{link}', link) });
    } catch {
      try { await Clipboard.setStringAsync(link); } catch { setError(L('rewardsErrorText')); }
    }
  };
  const submit = async () => {
    if (busyRef.current || !wallet || text.trim().length < 20) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try {
      await submitCosmeticFeedback(text.trim());
      setText(''); Keyboard.dismiss();
    } catch { setError(L('rewardsErrorText')); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <AppDialogModal
    visible={visible}
    onRequestClose={() => { Keyboard.dismiss(); onClose(); }}
    title={L('rewardsTitle')}
    message={editingFeedback ? undefined : L('rewardsIntro')}
    icon={<MaterialCommunityIcons name="star-four-points" size={24} color={CROWN_GOLD} />}
    actions={[
      { label: L('storeClose'), onPress: () => { Keyboard.dismiss(); onClose(); }, variant: 'cancel', disabled: busy },
      ...(!wallet?.feedbackSubmitted ? [{ label: L('rewardsFeedbackSend'), onPress: () => void submit(),
        variant: 'primary' as const, disabled: !wallet || text.trim().length < 20, busy }] : []),
    ]}
  >
    <View style={styles.body}>
      {!editingFeedback && wallet && targetPrice && targetPrice > wallet.balance ? <View style={styles.card}>
        <Text style={styles.title}>{L('rewardsInsufficient')}</Text>
        <Text style={styles.gift}>{L('rewardsNeed').replace('{points}', formatLiviPoints(targetPrice - wallet.balance, lang))}</Text>
      </View> : null}
      {!editingFeedback && <View style={styles.card}>
        <MaterialCommunityIcons name="account-multiple-plus-outline" size={26} color={UI_ACCENT} />
        <Text style={styles.title}>{L('rewardsInviteTitle')}</Text>
        <Text style={styles.copy}>{L('rewardsInviteRule').replace('{points}', formatLiviPoints(wallet?.invitePoints ?? 10, lang))}</Text>
        <Text style={styles.count}>{L('rewardsInvited').replace('{count}', String(wallet?.invitedCount ?? '—'))}</Text>
        <Pressable accessibilityRole="button" disabled={!userId} onPress={() => void share()} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>{L('rewardsShare')}</Text>
        </Pressable>
      </View>}
      <View style={styles.card}>
        <MaterialCommunityIcons name="gift-outline" size={26} color={CROWN_GOLD} />
        <Text style={styles.title}>{L('rewardsFeedbackTitle')}</Text>
        {wallet?.feedbackSubmitted ? <>
          <Text style={styles.copy}>{L('rewardsFeedbackDone')}</Text>
          <Text style={styles.gift}>{L(wallet.feedbackGiftAvailable ? 'rewardsGiftReady' : 'rewardsGiftUsed')}</Text>
        </> : <>
          {!editingFeedback && <Text style={styles.copy}>{L('rewardsFeedbackRule')}</Text>}
          <TextInput
            value={text} onChangeText={setText} multiline maxLength={2000}
            editable={!busy} placeholder={L('rewardsFeedbackPlaceholder')}
            onFocus={() => setEditingFeedback(true)} onBlur={() => setEditingFeedback(false)}
            placeholderTextColor={WELCOME_MUTED_TEXT} style={styles.input}
            accessibilityLabel={L('rewardsFeedbackTitle')} textAlignVertical="top"
          />
          <Text style={styles.counter}>{L('rewardsFeedbackCount').replace('{count}', String(text.trim().length))}</Text>
        </>}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  </AppDialogModal>;
}

const styles = StyleSheet.create({
  body: { gap: 14, padding: 16 },
  card: { padding: 16, gap: 10, borderRadius: 18, borderWidth: 1, borderColor: UI_RIM, backgroundColor: UI_SURFACE },
  title: { color: WELCOME_HEADER_TITLE, fontSize: 17, fontWeight: '700' },
  copy: { color: WELCOME_MUTED_TEXT, fontSize: 14, lineHeight: 21 },
  count: { color: UI_ACCENT_LIGHT, fontSize: 14, fontWeight: '600' },
  gift: { color: CROWN_GOLD, fontSize: 15, lineHeight: 22 },
  input: { color: WELCOME_HEADER_TITLE, minHeight: 110, maxHeight: 200, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', fontSize: 14, backgroundColor: 'rgba(0,0,0,0.18)' },
  counter: { color: WELCOME_MUTED_TEXT, fontSize: 12, textAlign: 'right' },
  button: { minHeight: 46, padding: 12, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(98, 176, 216, 0.58)', backgroundColor: UI_ACCENT_SOFT },
  buttonText: { color: UI_ACCENT_LIGHT, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  pressed: { opacity: 0.7 }, disabled: { opacity: 0.45 },
  error: { color: '#FF8E98', lineHeight: 20 },
});
