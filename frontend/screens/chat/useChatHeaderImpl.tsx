/** Memoized chat header JSX (not a component — avoids avatar remount flicker). */

import React from "react";
import { Platform, Pressable, Text, TouchableOpacity, View } from "react-native";
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import AvatarImage from "../../components/AvatarImage";
import ChatStyleBackButton from "../../components/ChatStyleBackButton";
import { t, type Lang } from "../../utils/i18n";
import { APP_TEXT_MAX_FONT_SIZE_MULTIPLIER } from "../../utils/accessibilityTypography";
import { WELCOME_CHROME_EDGE_RADIUS, WELCOME_NAV_ACTIVE_ACCENT } from "../home/constants";
import { StageGradient } from "../home/WelcomeStageBackground";
import type { BackdropSources } from "../../components/BackdropBlur";
import { CHAT_ROUND_BUTTON_SIZE, ChatRoundButton, chatRoundButtonColors } from "./ChatRoundButton";

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
  systemTopInset: number;
  LIVI: LiviColors;
  headerBg: string;
  navigation: any;
  isDark: boolean;
  peerNameState: string;
  peerOnline: boolean;
  peerId: string;
  peerAvatarVerState: number;
  fullAvatarUri: string | null | undefined;
  headerInitial: string;
  openAvatarModal: () => void | Promise<void>;
  onPressCall?: () => void;
  onPressMore?: () => void;
  /** Переписка с этим собеседником идёт со сквозным шифрованием. */
  encrypted?: boolean;
  selectionMode: boolean;
  selectedCount: number;
  exitSelectionMode: () => void;
  selectAllLoaded: () => void;
  startForwardSelected: () => void;
  confirmDeleteSelected: () => void;
  /** Источники стекла шапки (Android 12+). */
  backdrop?: BackdropSources;
};

/** Круглые action (звонок/меню) — того же размера, что кнопки композера. */
const ACTION_BTN = CHAT_ROUND_BUTTON_SIZE;
/** Hit-area «назад» / диаметр аватара. */
const BACK_BTN = 40;

export function useChatHeader({
  lang,
  headerH,
  headerTopPadding,
  systemTopInset,
  LIVI,
  headerBg,
  navigation,
  isDark,
  peerNameState,
  peerOnline,
  peerId,
  peerAvatarVerState,
  fullAvatarUri,
  headerInitial,
  openAvatarModal,
  onPressCall,
  onPressMore,
  encrypted = false,
  selectionMode,
  selectedCount,
  exitSelectionMode,
  selectAllLoaded,
  startForwardSelected,
  confirmDeleteSelected,
  backdrop,
}: Options): { headerEl: React.ReactElement } {
  // КРИТИЧНО: Header нельзя объявлять как "компонент-функцию" (const Header = () => ...)
  // и потом рендерить как <Header />, иначе при изменении зависимостей React будет считать,
  // что "тип компонента" поменялся → размонтирует/смонтирует заново (и аватар начнёт мерцать).
  const headerEl = React.useMemo(() => {
    // Те же круги, что у кнопок композера: сплошная заливка без обводки.
    const chromeBtnColors = chatRoundButtonColors(isDark);
    // Иконки в кругах — цвет имени собеседника.
    const chromeIconColor = isDark ? LIVI.white : LIVI.titan;
    const Shell = isDark ? StageGradient : View;

    const chromeBtnStyle = {
      width: ACTION_BTN,
      height: ACTION_BTN,
      borderRadius: ACTION_BTN / 2,
      backgroundColor: chromeBtnColors.idle,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    };

    return (
      <Shell
        {...(isDark ? { translucent: true, matteOpacity: 0.38, backdrop } : null)}
        style={{
          paddingTop: headerTopPadding + systemTopInset,
          height: headerH + headerTopPadding + systemTopInset,
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
        <View
          collapsable={false}
          renderToHardwareTextureAndroid
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            zIndex: 2,
            elevation: 2,
            // Верхний зазор остаётся компактным (2 dp), снизу под 40-dp
            // аватаром получается 6 dp — как над инпутом в нижнем chrome.
            transform: [{ translateY: -2 }],
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <TouchableOpacity
                onPress={selectAllLoaded}
                activeOpacity={0.85}
                style={{
                  height: ACTION_BTN,
                  paddingHorizontal: 12,
                  borderRadius: ACTION_BTN / 2,
                  backgroundColor: chromeBtnColors.idle,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{ color: LIVI.titan, fontSize: 13, fontWeight: "600" }}
                  numberOfLines={1}
                  maxFontSizeMultiplier={APP_TEXT_MAX_FONT_SIZE_MULTIPLIER}
                >
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
                  borderWidth: 1,
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
                  borderWidth: 0,
                }}
              />
            </Pressable>

            <View style={{ flex: 1, minWidth: 0, marginLeft: 10, marginRight: 8, justifyContent: "center" }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text
                  style={{
                    flexShrink: 1,
                    color: isDark ? LIVI.white : LIVI.titan,
                    fontSize: 17,
                    fontWeight: "600",
                    lineHeight: 21,
                  }}
                  numberOfLines={1}
                  maxFontSizeMultiplier={APP_TEXT_MAX_FONT_SIZE_MULTIPLIER}
                >
                  {peerNameState}
                </Text>
                {encrypted ? (
                  <MaterialIcons
                    name="verified-user"
                    size={12}
                    color={WELCOME_NAV_ACTIVE_ACCENT.softText}
                    style={{ marginLeft: 5 }}
                    accessible
                    accessibilityLabel={t("e2eEncryptedBadge", lang)}
                  />
                ) : null}
              </View>
              <Text
                style={{
                  marginTop: 2,
                  fontSize: Platform.OS === "android" ? 10 : 11,
                  lineHeight: Platform.OS === "android" ? 13 : 14,
                  color: peerOnline ? LIVI.presenceGreen : LIVI.presenceRed,
                  fontWeight: "300",
                  ...(Platform.OS === "android" && { fontFamily: "sans-serif-light" }),
                }}
                numberOfLines={1}
                maxFontSizeMultiplier={APP_TEXT_MAX_FONT_SIZE_MULTIPLIER}
              >
                {peerOnline ? t("online", lang) : t("offline", lang)}
              </Text>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
              <ChatRoundButton
                onPress={() => onPressCall?.()}
                backgroundColor={chromeBtnColors.idle}
                pressedBackgroundColor={chromeBtnColors.pressed}
                accessibilityLabel={t("tabCalls", lang)}
              >
                <MaterialCommunityIcons name="phone-in-talk-outline" size={23} color={chromeIconColor} />
              </ChatRoundButton>
              <ChatRoundButton
                onPress={() => onPressMore?.()}
                backgroundColor={chromeBtnColors.idle}
                pressedBackgroundColor={chromeBtnColors.pressed}
                accessibilityLabel={t("menuTitle", lang)}
              >
                <Ionicons name="ellipsis-vertical" size={20} color={chromeIconColor} />
              </ChatRoundButton>
            </View>
          </>
        )}
        </View>
      </Shell>
    );
  }, [
    headerH,
    headerTopPadding,
    systemTopInset,
    LIVI.white,
    LIVI.titan,
    LIVI.presenceGreen,
    LIVI.presenceRed,
    headerBg,
    navigation,
    isDark,
    peerNameState,
    peerOnline,
    peerId,
    peerAvatarVerState,
    fullAvatarUri,
    headerInitial,
    openAvatarModal,
    onPressCall,
    onPressMore,
    encrypted,
    selectionMode,
    selectedCount,
    exitSelectionMode,
    selectAllLoaded,
    startForwardSelected,
    confirmDeleteSelected,
    lang,
    backdrop,
  ]);

  return { headerEl };
}
