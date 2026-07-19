// screens/chat/ChatPeerActivityLabel.tsx
import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { t, type Lang } from "../../utils/i18n";

/** Animated "..." for peer typing/recording — isolated so ChatScreen doesn't re-render every ~420ms. */
export function ChatPeerActivityLabel({
  peerActivity,
  lang,
  isDark,
}: {
  peerActivity: "typing" | "recording";
  lang: Lang;
  isDark: boolean;
}) {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    setDots(1);
    const id = setInterval(() => {
      setDots((prev) => (prev % 3) + 1);
    }, 420);
    return () => clearInterval(id);
  }, [peerActivity]);

  const baseStyle = {
    fontSize: 13,
    fontStyle: "italic" as const,
    fontWeight: "500" as const,
    letterSpacing: 0.2,
  };
  const text =
    peerActivity === "recording"
      ? `${t("chatRecording", lang)}${".".repeat(dots)}`
      : `${t("chatTyping", lang)}${".".repeat(dots)}`;
  const color = isDark ? "rgba(255,255,255,0.40)" : "rgba(0,0,0,0.40)";

  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Text style={{ ...baseStyle, color }}>{text}</Text>
    </View>
  );
}
