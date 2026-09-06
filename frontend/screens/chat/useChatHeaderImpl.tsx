/** Memoized chat header JSX (not a component — avoids avatar remount flicker). */

import React from "react";
import { Platform, Pressable, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AvatarImage from "../../components/AvatarImage";
import ChatStyleBackButton from "../../components/ChatStyleBackButton";
import { t, type Lang } from "../../utils/i18n";
import { WELCOME_CHROME_EDGE_RADIUS } from "../home/constants";
import { StageGradient } from "../home/WelcomeStageBackground";

type LiviColors = {
  readonly bg: string;
  readonly white: string;
  readonly titan: string;
  readonly presenceGreen: string;
  readonly presenceRed: string;
};

type Options = {
  lang: Lang;
  headerH: number;
  headerTopPadding: number;
  LIVI: LiviColors;
  headerBg: string;
  navigation: any;
  isDark: boolean;
  outlineColor: string;
  peerNameState: string;
  peerOnline: boolean;
  peerId: string;
  peerAvatarVerState: number;
  fullAvatarUri: string | null | undefined;
  headerInitial: string;
  openAvatarModal: () => void | Promise<void>;
  onPressCall?: () => void;
  onPressMore?: () => void;
  selectionMode: boolean;
  selectedCount: number;
  exitSelectionMode: () => void;
  selectAllLoaded: () => void;
  startForwardSelected: () => void;
  confirmDeleteSelected: () => void;
};

/** Круглые action (звонок/меню) — как send в композере. */
const ACTION_BTN = 36;
/** Hit-area «назад» / диаметр аватара. */
const BACK_BTN = 40;

export function useChatHeader({
  lang,
  headerH,
  headerTopPadding,
  LIVI,
  headerBg,
  navigation,
  isDark,
  outlineColor,
  peerNameState,
  peerOnline,
  peerId,
  peerAvatarVerState,
  fullAvatarUri,
  headerInitial,
  openAvatarModal,
  onPressCall,
  onPressMore,
  selectionMode,
  selectedCount,
  exitSelectionMode,
  selectAllLoaded,
  startForwardSelected,
  confirmDeleteSelected,
}: Options): { headerEl: React.ReactElement } {
  // КРИТИЧНО: Header нельзя объявлять как "компонент-функцию" (const Header = () => ...)
  // и потом рендерить как <Header />, иначе при изменении зависимостей React будет считать,
  // что "тип компонента" поменялся → размонтирует/смонтирует заново (и аватар начнёт мерцать).
  const headerEl = React.useMemo(() => {
    // Как mic/send в нижнем композере: rgba(255,255,255,0.2) + outline.
    const chromeBtnBg = isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.06)";
    const chromeBtnBorder = outlineColor;
    const Shell = isDark ? StageGradient : View;

    const chromeBtnStyle = {
      width: ACTION_BTN,
      height: ACTION_BTN,
      borderRadius: ACTION_BTN / 2,
      backgroundColor: chromeBtnBg,
      borderWidth: 1,
      borderColor: chromeBtnBorder,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    };

    return (
      <Shell
        {...(isDark ? { translucent: true } : null)}
        style={{
          paddingTop: headerTopPadding,
          height: headerH + headerTopPadding,
          backgroundColor: isDark ? undefined : headerBg,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 12,
          zIndex: 2,
          elevation: 0,
          borderWidth: 0,
          overflow: "hidden",
          borderBottomLeftRadius: WELCOME_CHROME_EDGE_RADIUS,
          borderBottomRightRadius: WELCOME_CHROME_EDGE_RADIUS,
        }}
      >
        <ChatStyleBackButton
          icon={selectionMode ? "close" : "chevron-back"}
          iconColor={LIVI.titan}
          iconSize={20}
          style={{
            width: BACK_BTN,
            height: BACK_BTN,
            borderRadius: BACK_BTN / 2,
            backgroundColor: "transparent",
            borderWidth: 0,
            borderColor: "transparent",
          }}
          onPress={() => {
            if (selectionMode) exitSelectionMode();
            else navigation.goBack();
          }}
        />

        {selectionMode ? (
          <>
            <View style={{ flex: 1, alignItems: "center", marginHorizontal: 8 }}>
              <Text
                style={{
                  color: isDark ? LIVI.white : LIVI.titan,
                  fontSize: 18,
                  fontWeight: "600",
                }}
              >
                {t("chatSelectedCount", lang).replace("{count}", String(selectedCount))}
              </Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TouchableOpacity
                onPress={selectAllLoaded}
                activeOpacity={0.85}
                style={{
                  height: ACTION_BTN,
                  paddingHorizontal: 12,
                  borderRadius: ACTION_BTN / 2,
                  backgroundColor: chromeBtnBg,
                  borderColor: chromeBtnBorder,
                  borderWidth: 1,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: LIVI.titan, fontSize: 13, fontWeight: "600" }}>
                  {t("chatSelectAll", lang)}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={startForwardSelected}
                activeOpacity={0.85}
                style={{
                  ...chromeBtnStyle,
                  opacity: selectedCount === 0 ? 0.45 : 1,
                }}
              >
                <Ionicons name="paper-plane-outline" size={18} color={LIVI.titan} />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={confirmDeleteSelected}
                activeOpacity={0.85}
                style={{
                  ...chromeBtnStyle,
                  backgroundColor: isDark ? "rgba(255,90,103,0.14)" : "rgba(255,90,103,0.12)",
                  borderColor: "rgba(255,90,103,0.35)",
                  opacity: selectedCount === 0 ? 0.45 : 1,
                }}
              >
                <Ionicons name="trash-outline" size={18} color="#FF5A67" />
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Pressable
              onPress={openAvatarModal}
              style={{ marginLeft: 10 }}
              accessibilityRole="button"
            >
              <AvatarImage
                userId={peerId}
                avatarVer={peerAvatarVerState}
                uri={fullAvatarUri || undefined}
                size={BACK_BTN}
                fallbackText={headerInitial}
                fallbackTextStyle={{ color: isDark ? LIVI.white : LIVI.titan, fontWeight: "700" }}
                containerStyle={{
                  overflow: "hidden",
                  backgroundColor: isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.06)",
                  borderWidth: 1,
                  borderColor: outlineColor,
                }}
              />
            </Pressable>

            <View style={{ flex: 1, minWidth: 0, marginLeft: 10, marginRight: 8, justifyContent: "center" }}>
              <Text
                style={{
                  color: isDark ? LIVI.white : LIVI.titan,
                  fontSize: 17,
                  fontWeight: "600",
                  lineHeight: 21,
                }}
                numberOfLines={1}
              >
                {peerNameState}
              </Text>
              <Text
                style={{
                  marginTop: 2,
                  fontSize: 12,
                  color: peerOnline ? LIVI.presenceGreen : LIVI.presenceRed,
                  fontWeight: "400",
                  ...(Platform.OS === "android" && { fontFamily: "sans-serif" }),
                }}
              >
                {peerOnline ? t("online", lang) : t("offline", lang)}
              </Text>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <TouchableOpacity
                onPress={onPressCall}
                activeOpacity={0.85}
                style={chromeBtnStyle}
                accessibilityRole="button"
                accessibilityLabel={t("tabCalls", lang)}
              >
                <Ionicons name="videocam" size={20} color={LIVI.titan} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onPressMore}
                activeOpacity={0.85}
                style={chromeBtnStyle}
                accessibilityRole="button"
                accessibilityLabel={t("menuTitle", lang)}
              >
                <Ionicons name="ellipsis-vertical" size={20} color={LIVI.titan} />
              </TouchableOpacity>
            </View>
          </>
        )}
      </Shell>
    );
  }, [
    headerH,
    headerTopPadding,
    LIVI.white,
    LIVI.titan,
    LIVI.presenceGreen,
    LIVI.presenceRed,
    headerBg,
    navigation,
    isDark,
    outlineColor,
    peerNameState,
    peerOnline,
    peerId,
    peerAvatarVerState,
    fullAvatarUri,
    headerInitial,
    openAvatarModal,
    onPressCall,
    onPressMore,
    selectionMode,
    selectedCount,
    exitSelectionMode,
    selectAllLoaded,
    startForwardSelected,
    confirmDeleteSelected,
    lang,
  ]);

  return { headerEl };
}
