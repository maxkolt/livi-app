/**
 * «Заявки в друзья» — страница из вкладки «Друзья» (кнопка рядом с короной).
 *
 * Здесь все, кто ждёт ответа: заявки из случайного чата и открытые ссылки-
 * приглашения — в том числе если окно закрыли, связь оборвалась или приложение
 * вышло. Принять — друг в списке; удалить — заявки больше нет.
 * Вид — шапка с заголовком посередине на фоне как у верхнего блока «Друзей» (UI_SURFACE),
 * строки — как стеклянные строки «Звонков»: тот же тон, блик сверху и светлая кромка (сцены под
 * страницей нет — вид стекла нарисован напрямую).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import AdaptiveText from '../../components/AdaptiveText';
import AvatarImage from '../../components/AvatarImage';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { t, type Lang } from '../../utils/i18n';
import {
  acceptFriendRequest,
  declineFriendRequest,
  refreshFriendRequests,
  useFriendRequests,
  type FriendRequestItem,
} from '../../store/friendRequests';
import {
  LIVI,
  UI_ACCENT,
  UI_ACCENT_LIGHT,
  UI_SURFACE,
  WELCOME_FRIEND_ACTION_BTN_PRESSED_SURFACE,
  WELCOME_FRIEND_ACTION_BTN_SURFACE,
  WELCOME_FRIEND_AVATAR_SIZE,
  WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
  WELCOME_FRIEND_AVATAR_SIZE_TABLET,
  WELCOME_FRIEND_CARD_GAP,
  WELCOME_FRIEND_CARD_GAP_LANDSCAPE,
  WELCOME_FRIEND_CARD_GAP_TABLET,
  WELCOME_FRIEND_CARD_ROW_HEIGHT,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  isWelcomeTabletLayout,
  APP_TOP_CONTENT_GAP,
} from './constants';
import { FRIEND_ROW_ACTION_GAP } from '../../constants/uiTokens';
import { GLASS_HEADER_BTN } from './WelcomeGlassHeader';
import { WelcomeTabTitle } from './WelcomeTabTitle';
import { styles as homeStyles } from './styles';

/** Вид стеклянной строки «Звонков» (замерен на экране): тон, блик сверху, кромка. */
const ROW_GLASS_FILL = '#292F36';
const ROW_GLASS_SHEEN = ['rgba(255, 255, 255, 0.05)', 'rgba(255, 255, 255, 0)'] as const;
const ROW_GLASS_RIM = 'rgba(255, 255, 255, 0.12)';

const DECLINE_RED = '#FF5A67';
const DECLINE_RED_PRESSED = '#FF8A93';

type Props = {
  visible: boolean;
  onClose: () => void;
  lang: Lang;
  /** Уже друзья — их заявки не показываем (кэш мог отстать от сервера). */
  friendIds: Set<string>;
  /** Заявка принята — обновить список друзей. */
  onAccepted: () => void;
};

export function FriendRequestsPage({ visible, onClose, ...rest }: Props) {
  return (
    <FullScreenPortal visible={visible} onRequestClose={onClose}>
      <FriendRequestsContent visible={visible} onClose={onClose} {...rest} />
    </FullScreenPortal>
  );
}

function FriendRequestsContent({ visible, onClose, lang, friendIds, onAccepted }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height } = useSafeAreaFrame();
  const tablet = isWelcomeTabletLayout(width, height);
  const landscape = !tablet && width > 0 && height > 0 && width / height > 1.05;
  const items = useFriendRequests((s) => s.items);
  const busy = useFriendRequests((s) => s.busy);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    void refreshFriendRequests().finally(() => setLoading(false));
  }, [visible]);

  const rows = useMemo(() => items.filter((it) => !friendIds.has(it.id)), [items, friendIds]);

  const rowHeight = tablet
    ? WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET
    : landscape
      ? WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE
      : WELCOME_FRIEND_CARD_ROW_HEIGHT;
  const rowGap = tablet
    ? WELCOME_FRIEND_CARD_GAP_TABLET
    : landscape
      ? WELCOME_FRIEND_CARD_GAP_LANDSCAPE
      : WELCOME_FRIEND_CARD_GAP;
  const avatarSize = tablet
    ? WELCOME_FRIEND_AVATAR_SIZE_TABLET
    : landscape
      ? WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE
      : WELCOME_FRIEND_AVATAR_SIZE;
  // Как кнопки поиска/короны в шапке и звонка/чата в строке друга.
  const btnSize = tablet ? 44 : landscape ? 32 : GLASS_HEADER_BTN;
  const actionSize = tablet ? 44 : landscape ? 34 : 36;
  const sideInset = landscape ? 16 : WELCOME_FRIENDS_LIST_INSET;

  const accept = useCallback(
    async (id: string) => {
      if (await acceptFriendRequest(id)) onAccepted();
    },
    [onAccepted],
  );

  const renderItem = ({ item }: { item: FriendRequestItem }) => {
    const rowBusy = busy[item.id];
    const name = item.nick || t('user', lang);
    const letter = (item.nick || '').trim()[0]?.toUpperCase() || '';
    const cardRadius = tablet ? 18 : landscape ? 14 : 16;
    return (
      <View
        style={[
          styles.card,
          {
            height: rowHeight,
            marginBottom: rowGap,
            borderRadius: cardRadius,
            paddingLeft: tablet ? 14 : landscape ? 10 : 12,
          },
        ]}
      >
        <LinearGradient
          pointerEvents="none"
          colors={ROW_GLASS_SHEEN}
          locations={[0, 0.55]}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            styles.avatarBox,
            { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 },
          ]}
        >
          <AvatarImage
            userId={item.id}
            avatarVer={item.avatarVer || 0}
            uri={item.avatarThumbB64 || undefined}
            size={avatarSize}
            fallbackText={letter || '—'}
            containerStyle={{ overflow: 'hidden' }}
            fallbackTextStyle={
              letter ? { fontWeight: '800', color: LIVI.white } : { fontWeight: '400', color: LIVI.text2 }
            }
          />
        </View>
        <View style={styles.nameCol}>
          <AdaptiveText
            style={[
              homeStyles.friendName,
              styles.name,
              tablet && styles.nameTablet,
              landscape && styles.nameLandscape,
            ]}
            numberOfLines={1}
          >
            {name}
          </AdaptiveText>
        </View>
        <View style={styles.actions}>
          <RequestActionButton
            kind="accept"
            size={actionSize}
            busy={rowBusy === 'accept'}
            disabled={!!rowBusy}
            label={t('accept', lang)}
            onPress={() => void accept(item.id)}
          />
          <RequestActionButton
            kind="decline"
            size={actionSize}
            busy={rowBusy === 'decline'}
            disabled={!!rowBusy}
            label={t('delete', lang)}
            onPress={() => void declineFriendRequest(item.id)}
          />
        </View>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View
        style={[
          styles.page,
          {
            paddingTop: insets.top + APP_TOP_CONTENT_GAP,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={[styles.column, landscape && styles.columnLandscape]}>
          <View
            style={[
              styles.header,
              {
                paddingLeft: sideInset,
                paddingRight: sideInset,
                paddingTop: tablet ? 8 : 2,
                paddingBottom: tablet ? 10 : 4,
              },
            ]}
          >
            <WelcomeTabTitle label={t('friendRequestsTitle', lang)} tablet={tablet} compact={landscape} />
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('storeClose', lang)}
              style={({ pressed }) => [
                styles.backBtn,
                { width: btnSize, height: btnSize },
                pressed && styles.backBtnPressed,
              ]}
            >
              <Ionicons name="chevron-back" size={tablet ? 24 : landscape ? 19 : 20} color={WELCOME_HEADER_TITLE} />
            </Pressable>
          </View>

          {loading && rows.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator color={WELCOME_MUTED_TEXT} />
            </View>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(it) => it.id}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[
                styles.listContent,
                {
                  paddingHorizontal: sideInset,
                  paddingTop: landscape ? 8 : 14,
                  paddingBottom: insets.bottom + (tablet ? 16 : 12),
                },
                rows.length === 0 && styles.listEmpty,
              ]}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons name="people-outline" size={landscape ? 34 : 44} color={WELCOME_MUTED_TEXT} />
                  <AdaptiveText style={styles.emptyText}>{t('friendRequestsEmpty', lang)}</AdaptiveText>
                </View>
              }
            />
          )}
        </View>
      </View>
    </View>
  );
}

function RequestActionButton({
  kind,
  size,
  busy,
  disabled,
  label,
  onPress,
}: {
  kind: 'accept' | 'decline';
  size: number;
  busy: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const color = kind === 'accept' ? UI_ACCENT : DECLINE_RED;
  const pressedColor = kind === 'accept' ? UI_ACCENT_LIGHT : DECLINE_RED_PRESSED;
  const iconSize = size >= 44 ? 24 : size <= 34 ? 19 : 20;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => [
        WELCOME_FRIEND_ACTION_BTN_SURFACE,
        { width: size, height: size, borderRadius: size / 2 },
        pressed && !disabled ? WELCOME_FRIEND_ACTION_BTN_PRESSED_SURFACE : null,
        disabled && !busy && styles.actionDisabled,
      ]}
    >
      {({ pressed }) =>
        busy ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <MaterialCommunityIcons
            name={kind === 'accept' ? 'check' : 'close'}
            size={iconSize}
            color={pressed ? pressedColor : color}
          />
        )
      }
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Как фон верхнего блока «Друзей» (шапка с кнопками).
  root: { flex: 1, backgroundColor: UI_SURFACE },
  page: { flex: 1 },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  columnLandscape: { maxWidth: 560 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Просто стрелка, без круглой подложки; область нажатия прежняя.
  backBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnPressed: { opacity: 0.6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: {},
  listEmpty: { flexGrow: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 12,
    backgroundColor: ROW_GLASS_FILL,
    borderWidth: 0.8,
    borderColor: ROW_GLASS_RIM,
    overflow: 'hidden',
  },
  avatarBox: {
    overflow: 'visible',
    backgroundColor: 'rgba(132, 135, 140, 0.17)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameCol: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
    paddingRight: 8,
    justifyContent: 'center',
  },
  name: { fontSize: 16, lineHeight: 20 },
  nameLandscape: { fontSize: 14, lineHeight: 17 },
  nameTablet: { fontSize: 17, lineHeight: 22 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FRIEND_ROW_ACTION_GAP,
    flexShrink: 0,
  },
  actionDisabled: { opacity: 0.5 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingBottom: 48,
  },
  emptyText: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 15,
    textAlign: 'center',
  },
});
