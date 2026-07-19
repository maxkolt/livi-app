/** Gap between chat feed and composer: peer typing/recording or forward toast. */

import React from "react";
import { Animated, Text, View } from "react-native";
import { t, type Lang } from "../../utils/i18n";
import { ChatPeerActivityLabel } from "./ChatPeerActivityLabel";
import type { PeerActivity } from "./useChatTyping";

/** Visible gap height between last message and input top. */
export const CHAT_TYPING_GAP_H = -20;

export function shouldShowChatGapCenter(
  peerActivity: PeerActivity,
  forwardToast: { visible: boolean; text: string },
  lang: Lang,
): boolean {
  const peerTyping = peerActivity === "typing";
  const peerRecording = peerActivity === "recording";
  const isDeleteToast =
    forwardToast.visible && String(forwardToast.text || "") === t("chatDeleted", lang);
  return !!(peerTyping || peerRecording || (forwardToast.visible && !isDeleteToast));
}

export function shouldShowChatDeleteToast(
  forwardToast: { visible: boolean; text: string },
  lang: Lang,
): boolean {
  return (
    !!forwardToast.visible && String(forwardToast.text || "") === t("chatDeleted", lang)
  );
}

export function ChatGapCenterIndicator({
  peerActivity,
  forwardToast,
  forwardToastOpacity,
  isDark,
  lang,
}: {
  peerActivity: PeerActivity;
  forwardToast: { visible: boolean; ok: boolean; text: string };
  forwardToastOpacity: Animated.Value;
  isDark: boolean;
  lang: Lang;
}) {
  if (!shouldShowChatGapCenter(peerActivity, forwardToast, lang)) return null;

  const peerTyping = peerActivity === "typing";
  const peerRecording = peerActivity === "recording";

  const baseStyle = {
    fontSize: 13,
    fontStyle: "italic" as const,
    fontWeight: "500" as const,
    letterSpacing: 0.2,
  };

  const color =
    peerTyping || peerRecording
      ? isDark
        ? "rgba(255,255,255,0.40)"
        : "rgba(0,0,0,0.40)"
      : forwardToast.ok
        ? "#55d187"
        : "#FF5A67";

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        justifyContent: "center",
        alignItems: "center",
        opacity: peerTyping || peerRecording ? 1 : forwardToastOpacity,
      }}
    >
      {peerTyping || peerRecording ? (
        <ChatPeerActivityLabel
          peerActivity={peerRecording ? "recording" : "typing"}
          lang={lang}
          isDark={isDark}
        />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ ...baseStyle, color }}>
            {String(forwardToast.text || t("chatSent", lang))}
          </Text>
        </View>
      )}
    </Animated.View>
  );
}

export function ChatDeleteToastInline({
  forwardToast,
  forwardToastOpacity,
  lang,
}: {
  forwardToast: { visible: boolean; ok: boolean; text: string };
  forwardToastOpacity: Animated.Value;
  lang: Lang;
}) {
  if (!shouldShowChatDeleteToast(forwardToast, lang)) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        alignItems: "center",
        opacity: forwardToastOpacity,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontStyle: "italic",
          fontWeight: "500",
          letterSpacing: 0.2,
          color: "#FF5A67",
        }}
      >
        {forwardToast.text}
      </Text>
    </Animated.View>
  );
}
