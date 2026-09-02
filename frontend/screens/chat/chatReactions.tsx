// screens/chat/chatReactions.tsx
import React from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  Animated,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StageGradient } from "../home/WelcomeStageBackground";

export const REACTION_EMOJIS_PAGE_1 = ["👍", "😊", "❤️", "😮", "😢", "👎"];
export const REACTION_EMOJIS_PAGE_2 = ["😉", "😂", "😍", "😭", "🙏", "🔥"];
/** Порядок в bottom sheet по зажиму: первый ряд — 👍 ❤️ 🙏 🔥 😉 😂, второй — остальные */
export const SHEET_REACTIONS_ROW_1 = ["👍", "❤️", "🙏", "🔥", "😉", "😂"];
export const SHEET_REACTIONS_ROW_2 = ["😊", "😮", "😢", "👎", "😍", "😭"];
export const SHEET_REACTIONS_ALL = [...SHEET_REACTIONS_ROW_1, ...SHEET_REACTIONS_ROW_2];
export const REACTIONS_PAGE_SIZE = 4;

export function ReactionBarModal({
  visible,
  onClose,
  onPickEmoji,
  isDark,
}: {
  visible: boolean;
  onClose: () => void;
  onPickEmoji: (emoji: string) => void;
  isDark: boolean;
}) {
  const scrollRef = React.useRef<ScrollView>(null);
  const hintBounce = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [visible]);

  React.useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(hintBounce, { toValue: 6, duration: 500, useNativeDriver: true }),
        Animated.timing(hintBounce, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]),
      { iterations: -1 },
    );
    loop.start();
    return () => loop.stop();
  }, [visible, hintBounce]);

  const barWidth = Math.min(320, Dimensions.get("window").width * 0.88);
  const Shell = isDark ? StageGradient : View;

  const barStyle = {
    width: barWidth,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    backgroundColor: isDark ? undefined : "#2d3238",
    borderRadius: 24,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)" as const,
    overflow: "hidden" as const,
  };

  const renderEmojiRow = (emojis: string[]) => (
    <View
      style={{
        flexDirection: "row",
        flex: 1,
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      {emojis.map((emoji) => (
        <Pressable
          key={emoji}
          onPress={() => onPickEmoji(emoji)}
          style={{ padding: 6, minWidth: 36, alignItems: "center", justifyContent: "center" }}
          hitSlop={8}
        >
          <Text style={{ fontSize: 24 }}>{emoji}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "rgba(0,0,0,0.4)",
        }}
        onPress={onClose}
      >
        <Pressable onPress={() => {}} style={{ width: barWidth, overflow: "hidden", borderRadius: 24 }}>
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={barWidth}
            snapToAlignment="start"
            contentContainerStyle={{ flexGrow: 1 }}
            style={{ borderRadius: 24, overflow: "hidden" }}
          >
            <Shell style={barStyle}>
              <Animated.View
                style={{
                  marginRight: 6,
                  paddingRight: 8,
                  borderRightWidth: 1,
                  borderRightColor: "rgba(255,255,255,0.15)",
                  transform: [{ translateX: hintBounce }],
                  justifyContent: "center",
                }}
              >
                <Ionicons name="chevron-back" size={18} color="rgba(255,255,255,0.8)" />
              </Animated.View>
              {renderEmojiRow(REACTION_EMOJIS_PAGE_1)}
            </Shell>
            <Shell style={barStyle}>{renderEmojiRow(REACTION_EMOJIS_PAGE_2)}</Shell>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Один ряд реакций: по 4 эмодзи на страницу, на первой — стрелка «свайп вправо» */
export function ReactionsRowWithSwipe({
  selectedMessage,
  hideMessageActions,
  sendMessageReaction,
  peerId,
  isDark,
}: {
  selectedMessage: any;
  hideMessageActions: () => void;
  sendMessageReaction: (msgId: string, emoji: string, peerId: string) => Promise<unknown>;
  peerId: string;
  isDark: boolean;
}) {
  const scrollRef = React.useRef<ScrollView>(null);
  const rowW = 220 - 24;
  const arrowBounce = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(arrowBounce, { toValue: 4, duration: 600, useNativeDriver: true }),
        Animated.timing(arrowBounce, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
      { iterations: -1 },
    );
    loop.start();
    return () => loop.stop();
  }, [arrowBounce]);
  const emojiPress = (emoji: string) => {
    hideMessageActions();
    const msgId = selectedMessage?.id != null ? String(selectedMessage.id) : null;
    if (msgId) sendMessageReaction(msgId, emoji, peerId).catch(() => {});
  };
  const emojiStyle = (pressed: boolean) => ({
    padding: 4,
    minWidth: 30,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 10,
    backgroundColor: pressed
      ? isDark
        ? "rgba(255,255,255,0.08)"
        : "rgba(0,0,0,0.06)"
      : "transparent",
  });
  const pages: string[][] = [];
  for (let i = 0; i < SHEET_REACTIONS_ALL.length; i += REACTIONS_PAGE_SIZE) {
    pages.push(SHEET_REACTIONS_ALL.slice(i, i + REACTIONS_PAGE_SIZE));
  }
  return (
    <View style={{ borderRadius: 20, overflow: "hidden", paddingVertical: 4, paddingHorizontal: 4 }}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={rowW}
        snapToAlignment="start"
        contentContainerStyle={{ paddingHorizontal: 4 }}
        style={{ marginHorizontal: -4 }}
      >
        {pages.map((emojis, pageIndex) => (
          <View
            key={pageIndex}
            style={{
              width: rowW,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: pageIndex === 0 ? "space-between" : "space-around",
              paddingVertical: 2,
              paddingRight: pageIndex === 0 ? 8 : 0,
            }}
          >
            {emojis.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => emojiPress(emoji)}
                style={({ pressed }) => emojiStyle(pressed)}
                hitSlop={4}
              >
                <Text style={{ fontSize: 20 }}>{emoji}</Text>
              </Pressable>
            ))}
            {pageIndex === 0 && (
              <Animated.View style={{ marginLeft: 4, transform: [{ translateX: arrowBounce }] }}>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={isDark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)"}
                />
              </Animated.View>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
