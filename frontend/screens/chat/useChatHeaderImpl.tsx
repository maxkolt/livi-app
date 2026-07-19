/** Memoized chat header JSX (not a component — avoids avatar remount flicker). */

import React from "react";
import { Platform, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AvatarImage from "../../components/AvatarImage";
import ChatStyleBackButton from "../../components/ChatStyleBackButton";
import {
  FRIEND_ACTION_BUTTON,
  FRIEND_ACTION_ICON_SIZE,
} from "../../constants/uiTokens";
import { t, type Lang } from "../../utils/i18n";

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
  BORDER_WIDTH: number;
  BORDER_COLOR: string;
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
  selectionMode: boolean;
  selectedCount: number;
  exitSelectionMode: () => void;
  selectAllLoaded: () => void;
  startForwardSelected: () => void;
  confirmDeleteSelected: () => void;
};

export function useChatHeader({
  lang,
  headerH,
  headerTopPadding,
  LIVI,
  BORDER_WIDTH,
  BORDER_COLOR,
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
  // Поэтому делаем мемоизированный JSX-элемент.
  const headerEl = React.useMemo(() => (
    <View
      style={{
        paddingTop: headerTopPadding,
        height: headerH + headerTopPadding,
        backgroundColor: LIVI.bg,
        borderBottomWidth: BORDER_WIDTH,
        borderBottomColor: BORDER_COLOR,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
      }}
    >
      <ChatStyleBackButton
        icon={selectionMode ? 'close' : 'arrow-back'}
        iconColor={LIVI.titan}
        iconSize={FRIEND_ACTION_ICON_SIZE - 2}
        style={{
          width: 40,
          height: 40,
          borderRadius: FRIEND_ACTION_BUTTON.borderRadius - 1,
          ...(isDark
            ? null
            : {
                backgroundColor: 'rgba(0,0,0,0.06)',
                borderWidth: 1,
                borderColor: outlineColor,
              }),
        }}
        onPress={() => {
          if (selectionMode) exitSelectionMode();
          else navigation.goBack();
        }}
      />

      <View style={{ flex: 1, alignItems: "center" }}>
        <Text style={{
          color: LIVI.titan,
          fontSize: 18,
          fontWeight: "700",
        }}>
          {selectionMode ? t('chatSelectedCount', lang).replace('{count}', String(selectedCount)) : peerNameState}
        </Text>
        {!selectionMode && (
          <Text style={{
              marginTop: 2,
              fontSize: 11,
              color: peerOnline ? LIVI.presenceGreen : LIVI.presenceRed,
              fontWeight: '300',
              ...(Platform.OS === 'android' && { fontFamily: 'sans-serif-light' }),
            }}>
            {peerOnline ? t('online', lang) : t('offline', lang)}
          </Text>
        )}
      </View>

      {selectionMode ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TouchableOpacity
            onPress={selectAllLoaded}
            activeOpacity={0.85}
            style={{
              height: 36,
              paddingHorizontal: 10,
              borderRadius: 14,
              backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
              borderColor: outlineColor,
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: LIVI.titan, fontSize: 13, fontWeight: '600' }}>{t('chatSelectAll', lang)}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={startForwardSelected}
            activeOpacity={0.85}
            style={{
              width: 36,
              height: 36,
              borderRadius: 14,
              backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
              borderColor: outlineColor,
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
              opacity: selectedCount === 0 ? 0.45 : 1,
            }}
          >
            <Ionicons name="paper-plane-outline" size={18} color={LIVI.titan} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={confirmDeleteSelected}
            activeOpacity={0.85}
            style={{
              width: 36,
              height: 36,
              borderRadius: 14,
              backgroundColor: isDark ? "rgba(255,90,103,0.14)" : "rgba(255,90,103,0.12)",
              borderColor: 'rgba(255,90,103,0.35)',
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
              opacity: selectedCount === 0 ? 0.45 : 1,
            }}
          >
            <Ionicons name="trash-outline" size={18} color="#FF5A67" />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity onPress={openAvatarModal} activeOpacity={0.8}>
          <AvatarImage
            userId={peerId}
            avatarVer={peerAvatarVerState}
            uri={fullAvatarUri || undefined}
            size={FRIEND_ACTION_BUTTON.width}
            fallbackText={headerInitial}
            fallbackTextStyle={{ color: LIVI.titan }}
            // If no avatar: match back button background + 1px outline
            containerStyle={
              fullAvatarUri
                ? undefined
                : {
                    backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
                    borderWidth: 1,
                    borderColor: outlineColor,
                  }
            }
          />
        </TouchableOpacity>
      )}
    </View>
  ), [
    headerH,
    headerTopPadding,
    LIVI.bg,
    LIVI.white,
    LIVI.titan,
    LIVI.presenceGreen,
    LIVI.presenceRed,
    BORDER_WIDTH,
    BORDER_COLOR,
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
