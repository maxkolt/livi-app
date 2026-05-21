import React from 'react';
import { View, StyleSheet } from 'react-native';
import { EmojiKeyboard, en, ru, type EmojiType } from 'rn-emoji-keyboard';

export const CHAT_EMOJI_PANEL_HEIGHT = 280;

type Props = {
  isDark: boolean;
  surfaceBg: string;
  textColor: string;
  langCode: string;
  onEmojiSelected: (emoji: EmojiType) => void;
};

export default function ChatEmojiKeyboard({
  isDark,
  surfaceBg,
  textColor,
  langCode,
  onEmojiSelected,
}: Props) {
  const translation = langCode === 'ru' ? ru : en;

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
    <View style={styles.wrap}>
      <EmojiKeyboard
        onEmojiSelected={onEmojiSelected}
        enableSearchBar
        enableRecentlyUsed
        categoryPosition="top"
        translation={translation}
        theme={theme}
        disableSafeArea
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: CHAT_EMOJI_PANEL_HEIGHT,
    overflow: 'hidden',
  },
});
