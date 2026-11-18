import React from 'react';
import { Linking, Text, type StyleProp, type TextStyle } from 'react-native';

type Props = {
  text: string;
  style: StyleProp<TextStyle>;
  linkColor: string;
  onLongPressLink: () => void;
  linksDisabled?: boolean;
};

/** Shared text body for ordinary messages and captions placed beneath a photo/album. */
export function ChatMessageText({ text, style, linkColor, onLongPressLink, linksDisabled = false }: Props) {
  const segments = text.split(/(https?:\/\/[^\s<>"\]]+|www\.[^\s<>"\]]+)/gi).filter(Boolean);
  return (
    <Text style={style}>
      {segments.map((value, index) => /^(https?:\/\/|www\.)/i.test(value) ? (
        <Text
          key={index}
          style={[style, { color: linkColor, textDecorationLine: 'underline' }]}
          onPress={linksDisabled ? undefined : () => { void Linking.openURL(/^https?:\/\//i.test(value) ? value : `https://${value}`).catch(() => {}); }}
          onLongPress={linksDisabled ? undefined : onLongPressLink}
        >
          {value}
        </Text>
      ) : <Text key={index}>{value}</Text>)}
    </Text>
  );
}
