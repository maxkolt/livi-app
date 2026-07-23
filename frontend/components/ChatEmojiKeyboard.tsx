import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EmojiKeyboard, en, ru, type EmojiType } from 'rn-emoji-keyboard';
import { BUILT_IN_STICKER_PACKS, StickerView, type BuiltInSticker } from './chatStickers';
import { t, type Lang } from '../utils/i18n';

export const CHAT_EMOJI_PANEL_HEIGHT = 280;
const CHAT_EXPRESSION_SWITCH_HEIGHT = 42;
const CHAT_STICKER_PACK_HEIGHT = 42;

type Props = {
  isDark: boolean;
  surfaceBg: string;
  textColor: string;
  langCode: string;
  onEmojiSelected: (emoji: EmojiType) => void;
  onStickerSelected?: (sticker: BuiltInSticker) => void;
};

export default function ChatEmojiKeyboard({
  isDark,
  surfaceBg,
  textColor,
  langCode,
  onEmojiSelected,
  onStickerSelected,
}: Props) {
  const lang = (langCode || 'ru') as Lang;
  const [tab, setTab] = React.useState<'emoji' | 'stickers'>('emoji');
  const [packId, setPackId] = React.useState(BUILT_IN_STICKER_PACKS[0]?.id || '');
  const translation = lang === 'ru' ? ru : en;
  const activePack = BUILT_IN_STICKER_PACKS.find((pack) => pack.id === packId) || BUILT_IN_STICKER_PACKS[0];

  const theme = React.useMemo(
    () =>
      isDark
        ? {
            container: surfaceBg,
            header: textColor,
            knob: 'rgba(255,255,255,0.25)',
            skinTonesContainer: surfaceBg,
            category: {
              icon: 'rgba(255,255,255,0.45)',
              iconActive: textColor,
              container: surfaceBg,
              containerActive: 'rgba(255,255,255,0.08)',
            },
            search: {
              background: 'rgba(255,255,255,0.08)',
              text: textColor,
              placeholder: 'rgba(255,255,255,0.45)',
              icon: 'rgba(255,255,255,0.55)',
            },
            customButton: {
              icon: textColor,
              iconPressed: textColor,
              background: 'rgba(255,255,255,0.06)',
              backgroundPressed: 'rgba(255,255,255,0.12)',
            },
            emoji: { selected: 'rgba(255,255,255,0.12)' },
          }
        : {
            container: surfaceBg,
            header: textColor,
            knob: 'rgba(0,0,0,0.15)',
            skinTonesContainer: surfaceBg,
            category: {
              icon: 'rgba(0,0,0,0.35)',
              iconActive: textColor,
              container: surfaceBg,
              containerActive: 'rgba(0,0,0,0.06)',
            },
            search: {
              background: 'rgba(0,0,0,0.06)',
              text: textColor,
              placeholder: 'rgba(0,0,0,0.4)',
              icon: 'rgba(0,0,0,0.45)',
            },
            customButton: {
              icon: textColor,
              iconPressed: textColor,
              background: 'rgba(0,0,0,0.04)',
              backgroundPressed: 'rgba(0,0,0,0.08)',
            },
            emoji: { selected: 'rgba(0,0,0,0.08)' },
          },
    [isDark, surfaceBg, textColor],
  );

  return (
    <View style={[styles.wrap, { backgroundColor: surfaceBg }]}>
      <View style={styles.content}>
        {tab === 'emoji' ? (
          <EmojiKeyboard
            onEmojiSelected={onEmojiSelected}
            enableSearchBar={false}
            enableRecentlyUsed
            categoryPosition="top"
            translation={translation}
            theme={theme}
            disableSafeArea
            // Пустой search-ряд библиотека рисует локальным StyleSheet (не через styles prop).
            styles={{
              container: {
                borderRadius: 0,
                borderTopLeftRadius: 0,
                borderTopRightRadius: 0,
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
                elevation: 0,
                shadowOpacity: 0,
                shadowRadius: 0,
              },
            }}
          />
        ) : (
          <View style={styles.stickersPage}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.packSelector}
            >
              {BUILT_IN_STICKER_PACKS.map((pack) => {
                const active = pack.id === activePack.id;
                return (
                  <Pressable
                    key={pack.id}
                    onPress={() => setPackId(pack.id)}
                    style={({ pressed }) => [
                      styles.packButton,
                      {
                        backgroundColor: active
                          ? (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)')
                          : 'transparent',
                        opacity: pressed ? 0.78 : 1,
                      },
                    ]}
                  >
                    <Text style={styles.packIcon}>{pack.icon}</Text>
                    <Text style={[styles.packName, { color: textColor }]} numberOfLines={1}>
                      {pack.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.stickerGrid}
              keyboardShouldPersistTaps="always"
            >
              {activePack.stickers.map((sticker) => (
                <Pressable
                  key={sticker.id}
                  onPress={() => onStickerSelected?.(sticker)}
                  style={({ pressed }) => [
                    styles.stickerCell,
                    {
                      backgroundColor: pressed
                        ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)')
                        : 'transparent',
                      transform: [{ scale: pressed ? 0.96 : 1 }],
                    },
                  ]}
                >
                  <StickerView sticker={sticker} size={62} animated isDark={isDark} />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </View>
      <View style={[styles.switchBar, { borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)' }]}>
        {(['emoji', 'stickers'] as const).map((id) => {
          const active = tab === id;
          const label = id === 'emoji' ? t('chatEmojiTab', lang) : t('chatStickersTab', lang);
          return (
            <Pressable
              key={id}
              onPress={() => setTab(id)}
              style={({ pressed }) => [
                styles.switchButton,
                {
                  backgroundColor: active
                    ? (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)')
                    : 'transparent',
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              <Text style={{ color: active ? textColor : (isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)'), fontWeight: active ? '700' : '600', fontSize: 13 }}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: CHAT_EMOJI_PANEL_HEIGHT,
    overflow: 'hidden',
  },
  content: {
    height: CHAT_EMOJI_PANEL_HEIGHT - CHAT_EXPRESSION_SWITCH_HEIGHT,
    overflow: 'hidden',
  },
  stickersPage: {
    flex: 1,
  },
  packSelector: {
    height: CHAT_STICKER_PACK_HEIGHT,
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  packButton: {
    height: 32,
    minWidth: 78,
    borderRadius: 16,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  packIcon: {
    fontSize: 17,
    marginRight: 5,
  },
  packName: {
    fontSize: 12,
    fontWeight: '700',
  },
  stickerGrid: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  stickerCell: {
    width: '25%',
    height: 78,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchBar: {
    height: CHAT_EXPRESSION_SWITCH_HEIGHT,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  switchButton: {
    minWidth: 104,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
