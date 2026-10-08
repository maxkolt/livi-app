/**
 * Над полем ввода — ответ на сообщение или его редактирование, как в Telegram:
 * значок слева, цитата в той же «полурамке», что в облаке-ответе (скругление и
 * гаснущие к краю линии), заголовок цветом акцента, текст сообщения и крестик.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { ChatReplyQuoteAccent } from './ChatReplyQuoteAccent';

type Props = {
  mode: 'reply' | 'edit';
  title: string;
  text: string;
  accent: string;
  textColor: string;
  closeColor: string;
  closeA11y: string;
  onClose: () => void;
};

export function ChatComposerContextBar({
  mode,
  title,
  text,
  accent,
  textColor,
  closeColor,
  closeA11y,
  onClose,
}: Props) {
  return (
    <View style={styles.bar}>
      <View style={styles.icon}>
        {mode === 'edit' ? (
          <MaterialCommunityIcons name="pencil-outline" size={22} color={accent} />
        ) : (
          <Ionicons name="arrow-undo-outline" size={22} color={accent} />
        )}
      </View>
      <ChatReplyQuoteAccent color={accent} style={styles.quote}>
        <Text style={[styles.title, { color: accent }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.text, { color: textColor }]} numberOfLines={1} ellipsizeMode="tail">
          {text || '—'}
        </Text>
      </ChatReplyQuoteAccent>
      <Pressable
        onPress={onClose}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={closeA11y}
        style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
      >
        <Ionicons name="close" size={22} color={closeColor} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    paddingLeft: 2,
  },
  icon: {
    width: 30,
    alignItems: 'center',
    marginRight: 6,
  },
  quote: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  text: {
    fontSize: 14,
    opacity: 0.9,
  },
  close: {
    padding: 6,
    marginLeft: 4,
    borderRadius: 16,
  },
  closePressed: {
    opacity: 0.6,
  },
});
