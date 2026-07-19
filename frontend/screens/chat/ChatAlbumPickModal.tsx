// screens/chat/ChatAlbumPickModal.tsx
import React from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
} from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { CHAT_ALBUM_GAP, albumGridColumns } from "./chatAlbum";

export type AlbumPickKind = "save" | "forward" | "delete";

type Props = {
  visible: boolean;
  kind: AlbumPickKind;
  uris: string[];
  /** Pre-selected indices when opening (e.g. long-pressed tile). */
  initialSelected: number[];
  resolveMediaUri: (uri?: string) => string;
  isDark: boolean;
  bg: string;
  text: string;
  muted: string;
  accent: string;
  danger?: string;
  title: string;
  subtitle: string;
  selectAllLabel: string;
  clearLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  onClose: () => void;
  onConfirm: (indices: number[]) => void;
};

/**
 * Multi-select album photo picker for save / forward / delete.
 */
export function ChatAlbumPickModal({
  visible,
  kind,
  uris,
  initialSelected,
  resolveMediaUri,
  isDark,
  bg,
  text,
  muted,
  accent,
  danger = "#FF5A67",
  title,
  subtitle,
  selectAllLabel,
  clearLabel,
  confirmLabel,
  cancelLabel,
  onClose,
  onConfirm,
}: Props) {
  const [selected, setSelected] = React.useState<Set<number>>(() => new Set());
  const [innerW, setInnerW] = React.useState(0);

  React.useEffect(() => {
    if (!visible) return;
    const next = new Set<number>();
    for (const i of initialSelected) {
      if (i >= 0 && i < uris.length) next.add(i);
    }
    if (next.size === 0 && uris.length > 0) next.add(0);
    setSelected(next);
  }, [visible, initialSelected, uris.length]);

  const cols = albumGridColumns(Math.min(Math.max(uris.length, 2), 6));
  const tile =
    innerW > 0
      ? Math.max(1, Math.floor((innerW - CHAT_ALBUM_GAP * (cols - 1)) / cols))
      : 0;
  const allSelected = uris.length > 0 && selected.size === uris.length;
  const count = selected.size;
  const canConfirm = count > 0;
  const actionColor = kind === "delete" ? danger : accent;

  const toggle = (index: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(index)) {
        if (n.size <= 1) return n; // keep at least one
        n.delete(index);
      } else {
        n.add(index);
      }
      return n;
    });
  };

  const selectAll = () => {
    setSelected(new Set(uris.map((_, i) => i)));
  };

  const selectNoneKeepOne = () => {
    const first = initialSelected.find((i) => i >= 0 && i < uris.length) ?? 0;
    setSelected(new Set([first]));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: isDark ? "rgba(0,0,0,0.58)" : "rgba(0,0,0,0.36)",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            width: "100%",
            maxWidth: 400,
            borderRadius: 22,
            backgroundColor: bg,
            overflow: "hidden",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
            ...Platform.select({
              ios: {
                shadowColor: "#000",
                shadowOpacity: 0.22,
                shadowRadius: 28,
                shadowOffset: { width: 0, height: 14 },
              },
              android: { elevation: 10 },
            }),
          }}
        >
          <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 10 }}>
            <Text
              style={{
                color: text,
                fontSize: 17,
                fontWeight: "400",
                letterSpacing: 0.2,
              }}
            >
              {title}
            </Text>
            <Text
              style={{
                marginTop: 6,
                color: muted,
                fontSize: 13,
                fontWeight: "300",
                letterSpacing: 0.15,
                lineHeight: 18,
              }}
            >
              {subtitle.replace("{count}", String(count))}
            </Text>
          </View>

          <View
            style={{
              flexDirection: "row",
              paddingHorizontal: 16,
              paddingBottom: 10,
              gap: 8,
            }}
          >
            <Pressable
              onPress={allSelected ? selectNoneKeepOne : selectAll}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 999,
                backgroundColor: pressed
                  ? (isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)")
                  : (isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"),
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)",
              })}
            >
              <Text style={{ color: muted, fontSize: 12, fontWeight: "400", letterSpacing: 0.2 }}>
                {allSelected ? clearLabel : selectAllLabel}
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ maxHeight: 320 }}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 8 }}
            showsVerticalScrollIndicator={false}
          >
            <View
              onLayout={(e) => {
                const w = Math.round(e.nativeEvent.layout.width);
                if (w > 0 && w !== innerW) setInnerW(w);
              }}
              style={{
                width: "100%",
                flexDirection: "row",
                flexWrap: "wrap",
                gap: CHAT_ALBUM_GAP,
              }}
            >
              {uris.map((raw, index) => {
                const uri = resolveMediaUri(raw) || raw;
                const on = selected.has(index);
                return (
                  <Pressable
                    key={`pick-${index}-${raw.slice(-20)}`}
                    onPress={() => toggle(index)}
                    style={{
                      width: tile || undefined,
                      aspectRatio: 1,
                      flexGrow: tile ? 0 : 1,
                      flexBasis: tile ? undefined : `${Math.floor(100 / cols) - 1}%`,
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                    }}
                  >
                    {tile > 0 ? (
                      <ExpoImage
                        source={{ uri }}
                        style={{ width: "100%", height: "100%" }}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={0}
                      />
                    ) : null}
                    <View
                      pointerEvents="none"
                      style={{
                        ...StyleSheet.absoluteFillObject,
                        backgroundColor: on
                          ? (isDark ? "rgba(46,196,182,0.22)" : "rgba(113,91,168,0.18)")
                          : "rgba(0,0,0,0.12)",
                      }}
                    />
                    <View
                      style={{
                        position: "absolute",
                        top: 7,
                        right: 7,
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: on ? accent : "rgba(0,0,0,0.35)",
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: on ? accent : "rgba(255,255,255,0.45)",
                      }}
                    >
                      {on ? (
                        <Ionicons
                          name="checkmark"
                          size={14}
                          color={isDark ? "#0B0B0C" : "#FFFFFF"}
                        />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          <View
            style={{
              flexDirection: "row",
              gap: 10,
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: 16,
            }}
          >
            <Pressable
              onPress={onClose}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 13,
                borderRadius: 14,
                alignItems: "center",
                backgroundColor: pressed
                  ? (isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)")
                  : (isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)"),
              })}
            >
              <Text style={{ color: muted, fontSize: 15, fontWeight: "400", letterSpacing: 0.2 }}>
                {cancelLabel}
              </Text>
            </Pressable>
            <Pressable
              disabled={!canConfirm}
              onPress={() => {
                if (!canConfirm) return;
                onConfirm(Array.from(selected).sort((a, b) => a - b));
              }}
              style={({ pressed }) => ({
                flex: 1.35,
                paddingVertical: 13,
                borderRadius: 14,
                alignItems: "center",
                opacity: canConfirm ? 1 : 0.45,
                backgroundColor: pressed
                  ? (kind === "delete" ? "rgba(255,90,103,0.28)" : `${accent}33`)
                  : (kind === "delete" ? "rgba(255,90,103,0.16)" : `${accent}22`),
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: kind === "delete" ? "rgba(255,90,103,0.45)" : `${accent}66`,
              })}
            >
              <Text
                style={{
                  color: actionColor,
                  fontSize: 15,
                  fontWeight: "500",
                  letterSpacing: 0.25,
                }}
              >
                {confirmLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
