import React, { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import AdaptiveText from '../../components/AdaptiveText';
import type { Lang } from '../../utils/i18n';
import AvatarImage from '../../components/AvatarImage';
import { LIVI, WELCOME_GLASS_BORDER, WELCOME_GLASS_SURFACE, WELCOME_HEADER_TITLE, WELCOME_MUTED_TEXT, WELCOME_STAGE_BG } from './constants';
import { formatWelcomeUsersOnlineLine } from './utils/welcomeOnlineLabel';

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
};

const STACK_SIZE = 32;
const STACK_SIZE_DENSE = 24;
const STACK_OVERLAP = 12;
const STACK_OVERLAP_DENSE = 9;
const STACK_VISIBLE = 4;

function WelcomeOnlineBannerInner({
  lang,
  onlineLabel,
  onlineCount,
  peers,
  compact = false,
  dense = false,
  marginTop,
}: WelcomeOnlineBannerProps) {
  const countLine = formatWelcomeUsersOnlineLine(onlineCount, lang);
  const stackSize = dense ? STACK_SIZE_DENSE : STACK_SIZE;
  const stackOverlap = dense ? STACK_OVERLAP_DENSE : STACK_OVERLAP;
  const stackItemStyle = { borderRadius: stackSize / 2, borderWidth: dense ? 1.5 : 2 };
  const stackAvatarStyle = { width: stackSize, height: stackSize, borderRadius: stackSize / 2 };

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
        styles.pill,
        compact && styles.pillCompact,
        dense && styles.pillDense,
        marginTop != null ? { marginTop } : null,
      ]}
    >
      <View style={[styles.textCol, dense && styles.textColDense]}>
        <View style={[styles.onlineRow, dense && styles.onlineRowDense]}>
          <View style={[styles.onlineDot, dense && styles.onlineDotDense]} />
          <AdaptiveText
            style={[styles.onlineWord, compact && styles.onlineWordCompact, dense && styles.onlineWordDense]}
            numberOfLines={1}
          >
            {onlineLabel}
          </AdaptiveText>
        </View>
        <AdaptiveText
          style={[styles.countText, compact && styles.countTextCompact, dense && styles.countTextDense]}
          numberOfLines={dense ? 1 : 2}
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
                  fallbackText="—"
                  containerStyle={[styles.stackAvatar, stackAvatarStyle]}
                  fallbackTextStyle={styles.stackFallback}
                />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginHorizontal: 20,
    marginTop: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 26,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    gap: 14,
  },
  pillCompact: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 22,
    marginHorizontal: 16,
  },
  pillDense: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 18,
    marginHorizontal: 14,
    gap: 10,
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
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  onlineWordCompact: {
    fontSize: 14,
  },
  onlineWordDense: {
    fontSize: 13,
  },
  countText: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 16,
  },
  countTextCompact: {
    fontSize: 11,
  },
  countTextDense: {
    fontSize: 10,
    lineHeight: 13,
  },
  stack: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  stackItem: {
    borderColor: WELCOME_STAGE_BG,
    overflow: 'hidden',
  },
  stackAvatar: {
    overflow: 'hidden',
  },
  stackPlaceholder: {
    backgroundColor: 'rgba(59,130,246,0.22)',
  },
  stackFallback: {
    fontSize: 11,
    fontWeight: '700',
    color: LIVI.white,
  },
});

export const WelcomeOnlineBanner = memo(WelcomeOnlineBannerInner);
