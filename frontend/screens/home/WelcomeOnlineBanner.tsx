import React, { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import AdaptiveText from '../../components/AdaptiveText';
import type { Lang } from '../../utils/i18n';
import AvatarImage from '../../components/AvatarImage';
import {
  LIVI,
  UI_ACCENT_SOFT,
  UI_RIM,
  UI_GLASS_CONTROL,
  WELCOME_HEADER_TITLE,
  WELCOME_SEGMENT_LABEL,
} from './constants';
import { formatWelcomeUsersOnlineLine } from './utils/welcomeOnlineLabel';
import { useDigitalRegularFont } from './brandFont';

export type WelcomeBannerPeer = {
  id: string;
  name?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
  /** HTTP URL (`/api/avatar/:id?thumb=1`) — опционально, если нет локального thumb. */
  avatarUri?: string;
};

type WelcomeOnlineBannerProps = {
  lang: Lang;
  onlineLabel: string;
  onlineCount: number | null;
  /** До 4 онлайн-друзей; realtime с родителя. */
  peers: WelcomeBannerPeer[];
  compact?: boolean;
  /** Низкий экран: минимальная высота pill, аватары и текст мельче, счётчик в одну строку. */
  dense?: boolean;
  /** Переопределить верхний отступ pill (адаптив Search). */
  marginTop?: number;
  /** Боковые поля pill: 0, когда баннер уже лежит в колонке нужной ширины. */
  sideMargin?: number;
  /** Дополнительное действие внутри панели (на Поиске — кнопка короны). */
  trailingAction?: ReactNode;
};

const STACK_SIZE = 30;
const STACK_SIZE_DENSE = 22;
const STACK_OVERLAP = 11;
const STACK_OVERLAP_DENSE = 8;
const STACK_VISIBLE = 4;

function WelcomeOnlineBannerInner({
  lang,
  onlineLabel,
  onlineCount,
  peers,
  compact = false,
  dense = false,
  marginTop,
  sideMargin,
  trailingAction,
}: WelcomeOnlineBannerProps) {
  const countLine = formatWelcomeUsersOnlineLine(onlineCount, lang);
  const stackSize = dense ? STACK_SIZE_DENSE : STACK_SIZE;
  const stackOverlap = dense ? STACK_OVERLAP_DENSE : STACK_OVERLAP;
  const pillRadius = dense ? 18 : compact ? 22 : 26;
  const stackItemStyle = { borderRadius: stackSize / 2 };
  const stackAvatarStyle = { width: stackSize, height: stackSize, borderRadius: stackSize / 2 };

  // «Онлайн» — «цифровой» Exo 2, как ник и подписи навбара; размер прежний.
  const onlineFont = useDigitalRegularFont();
  const stackPeers = useMemo(() => {
    const live = peers.slice(0, STACK_VISIBLE);
    const out: WelcomeBannerPeer[] = [];
    for (let i = 0; i < STACK_VISIBLE; i++) {
      out.push(live[i] || { id: `placeholder-${i}`, name: '' });
    }
    return out;
  }, [peers]);

  return (
    <View
      style={[
        styles.floatWrap,
        trailingAction ? styles.floatWrapWithAction : null,
        compact && styles.floatWrapCompact,
        compact && trailingAction ? styles.floatWrapCompactWithAction : null,
        dense && styles.floatWrapDense,
        dense && trailingAction ? styles.floatWrapDenseWithAction : null,
        { borderRadius: pillRadius },
        marginTop != null ? { marginTop } : null,
        sideMargin != null ? { marginHorizontal: sideMargin } : null,
      ]}
    >
      <View
        style={[
          styles.pill,
          trailingAction ? styles.pillWithAction : null,
          compact && styles.pillCompact,
          compact && trailingAction ? styles.pillCompactWithAction : null,
          dense && styles.pillDense,
          dense && trailingAction ? styles.pillDenseWithAction : null,
        ]}
      >
      <View style={[styles.textCol, dense && styles.textColDense]}>
        <View style={[styles.onlineRow, dense && styles.onlineRowDense]}>
          <View style={[styles.onlineDot, dense && styles.onlineDotDense]} />
          <AdaptiveText
            style={[styles.onlineWord, compact && styles.onlineWordCompact, dense && styles.onlineWordDense, onlineFont]}
            numberOfLines={1}
          >
            {onlineLabel}
          </AdaptiveText>
        </View>
        <AdaptiveText
          style={[styles.countText, compact && styles.countTextCompact, dense && styles.countTextDense]}
          numberOfLines={1}
          minimumFontScale={0.72}
        >
          {countLine}
        </AdaptiveText>
      </View>
      <View style={styles.stack}>
        {stackPeers.map((peer, index) => {
          const isPlaceholder = String(peer.id).startsWith('placeholder-');
          const hasAvatar =
            !!(peer.avatarThumbB64 && peer.avatarThumbB64.length > 0) ||
            !!(peer.avatarUri && peer.avatarUri.length > 0) ||
            (Number(peer.avatarVer) || 0) > 0;
          const uri = peer.avatarThumbB64 || peer.avatarUri || undefined;
          return (
            <View
              key={isPlaceholder ? `placeholder-${index}` : peer.id}
              style={[
                styles.stackItem,
                stackItemStyle,
                {
                  marginLeft: index === 0 ? 0 : -stackOverlap,
                  zIndex: STACK_VISIBLE - index,
                },
              ]}
            >
              {isPlaceholder ? (
                <View style={[styles.stackPlaceholder, stackAvatarStyle]} />
              ) : (
                <AvatarImage
                  userId={peer.id}
                  avatarVer={hasAvatar ? peer.avatarVer || 0 : 0}
                  uri={hasAvatar ? uri : undefined}
                  size={stackSize}
                  // В стеке онлайна — просто кружки: купленные рамки профиля здесь не рисуем.
                  frameId={null}
                  fallbackText="—"
                  containerStyle={[styles.stackAvatar, stackAvatarStyle]}
                  fallbackTextStyle={styles.stackFallback}
                />
              )}
            </View>
          );
        })}
      </View>
      {trailingAction ? (
        <>
          <View style={[styles.actionDivider, dense && styles.actionDividerDense]} />
          <View style={styles.actionSlot}>{trailingAction}</View>
        </>
      ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  floatWrap: {
    alignSelf: 'stretch',
    marginHorizontal: 20,
    marginTop: 8,
    overflow: 'visible',
  },
  floatWrapCompact: {
    marginHorizontal: 16,
  },
  floatWrapWithAction: {
    marginHorizontal: 12,
  },
  floatWrapCompactWithAction: {
    marginHorizontal: 12,
  },
  floatWrapDense: {
    marginHorizontal: 14,
  },
  floatWrapDenseWithAction: {
    marginHorizontal: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 26,
    backgroundColor: UI_GLASS_CONTROL,
    borderWidth: 0,
    gap: 14,
  },
  pillCompact: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  pillWithAction: {
    minHeight: 78,
    paddingLeft: 20,
    paddingRight: 10,
    // Непрозрачный блок на верхнем стекле, как блок фильтров на «Друзьях».
    backgroundColor: UI_GLASS_CONTROL,
    borderWidth: StyleSheet.hairlineWidth,
    // Едва заметная светлая кромка — блок отделён от фона без цветной рамки.
    borderColor: UI_RIM,
  },
  pillCompactWithAction: {
    minHeight: 66,
    paddingLeft: 16,
    paddingRight: 8,
  },
  pillDense: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 18,
    gap: 10,
  },
  pillDenseWithAction: {
    minHeight: 44,
    paddingLeft: 12,
    paddingRight: 5,
  },
  textCol: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  textColDense: {
    gap: 1,
  },
  onlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  onlineRowDense: {
    gap: 6,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3DDC84',
  },
  onlineDotDense: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  onlineWord: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '400',
    letterSpacing: 0.1,
  },
  onlineWordCompact: {
    fontSize: 14,
  },
  onlineWordDense: {
    fontSize: 13,
  },
  countText: {
    // Мелкий текст — светлее приглушённого, иначе на блоке читается с трудом.
    color: WELCOME_SEGMENT_LABEL,
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 14,
  },
  countTextCompact: {
    fontSize: 10,
  },
  countTextDense: {
    fontSize: 9,
    lineHeight: 12,
  },
  stack: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  actionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 34,
    flexShrink: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  actionDividerDense: {
    height: 26,
  },
  actionSlot: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -6,
  },
  stackItem: {
    overflow: 'visible',
  },
  stackAvatar: {
    overflow: 'visible',
  },
  stackPlaceholder: {
    /** Тот же акцент, что радар / CTA. */
    backgroundColor: UI_ACCENT_SOFT,
  },
  stackFallback: {
    fontSize: 11,
    fontWeight: '700',
    color: LIVI.white,
  },
});

export const WelcomeOnlineBanner = memo(WelcomeOnlineBannerInner);
