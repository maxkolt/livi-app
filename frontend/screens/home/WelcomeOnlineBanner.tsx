import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Lang } from '../../utils/i18n';
import AvatarImage from '../../components/AvatarImage';
import { displayAvatarLetter } from './friendHelpers';
import { LIVI, WELCOME_GLASS_BORDER, WELCOME_GLASS_SURFACE, WELCOME_MUTED_TEXT, WELCOME_STAGE_BG } from './constants';
import { formatWelcomeUsersOnlineLine } from './utils/welcomeOnlineLabel';

export type WelcomeBannerPeer = {
  id: string;
  name?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
};

type WelcomeOnlineBannerProps = {
  lang: Lang;
  onlineLabel: string;
  onlineCount: number | null;
  peers: WelcomeBannerPeer[];
  compact?: boolean;
};

const STACK_SIZE = 32;
const STACK_OVERLAP = 12;

function WelcomeOnlineBannerInner({
  lang,
  onlineLabel,
  onlineCount,
  peers,
  compact = false,
}: WelcomeOnlineBannerProps) {
  const countLine = formatWelcomeUsersOnlineLine(onlineCount, lang);

  const stackPeers = peers.slice(0, 4);
  while (stackPeers.length < 4) {
    stackPeers.push({ id: `placeholder-${stackPeers.length}`, name: '' });
  }

  return (
    <View style={[styles.pill, compact && styles.pillCompact]}>
      <View style={styles.textCol}>
        <View style={styles.onlineRow}>
          <View style={styles.onlineDot} />
          <Text style={[styles.onlineWord, compact && styles.onlineWordCompact]}>{onlineLabel}</Text>
        </View>
        <Text style={[styles.countText, compact && styles.countTextCompact]} numberOfLines={2}>
          {countLine}
        </Text>
      </View>
      <View style={styles.stack}>
        {stackPeers.map((peer, index) => {
          const isPlaceholder = String(peer.id).startsWith('placeholder-');
          const letter = displayAvatarLetter(peer.name || '');
          return (
            <View
              key={peer.id}
              style={[
                styles.stackItem,
                {
                  marginLeft: index === 0 ? 0 : -STACK_OVERLAP,
                  zIndex: 4 - index,
                },
              ]}
            >
              {isPlaceholder ? (
                <View style={styles.stackPlaceholder} />
              ) : (
                <AvatarImage
                  userId={peer.id}
                  avatarVer={peer.avatarVer || 0}
                  uri={peer.avatarThumbB64 || undefined}
                  size={STACK_SIZE}
                  fallbackText={letter || '·'}
                  containerStyle={styles.stackAvatar}
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
    marginTop: 16,
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
  textCol: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  onlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3DDC84',
  },
  onlineWord: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  onlineWordCompact: {
    fontSize: 14,
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
  stack: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  stackItem: {
    borderRadius: STACK_SIZE / 2,
    borderWidth: 2,
    borderColor: WELCOME_STAGE_BG,
    overflow: 'hidden',
  },
  stackAvatar: {
    width: STACK_SIZE,
    height: STACK_SIZE,
    borderRadius: STACK_SIZE / 2,
    overflow: 'hidden',
  },
  stackPlaceholder: {
    width: STACK_SIZE,
    height: STACK_SIZE,
    borderRadius: STACK_SIZE / 2,
    backgroundColor: 'rgba(59,130,246,0.22)',
  },
  stackFallback: {
    fontSize: 11,
    fontWeight: '700',
    color: LIVI.white,
  },
});

export const WelcomeOnlineBanner = memo(WelcomeOnlineBannerInner);
