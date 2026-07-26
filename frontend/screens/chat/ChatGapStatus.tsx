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

  const toastColor = forwardToast.ok ? "rgba(255,255,255,0.96)" : "#FF8A93";

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
        <View
          style={{
            alignSelf: "center",
            paddingVertical: 7,
            paddingHorizontal: 16,
            borderRadius: 999,
            backgroundColor: "rgba(12, 14, 18, 0.82)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.10)",
            maxWidth: "72%",
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              fontSize: 13,
              fontWeight: "600",
              letterSpacing: 0.25,
              color: toastColor,
              textAlign: "center",
            }}
          >
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
          fontWeight: "600",
          letterSpacing: 0.25,
          color: "#FF8A93",
          textAlign: "center",
        }}
      >
        {forwardToast.text}
      </Text>
    </Animated.View>
  );
}
