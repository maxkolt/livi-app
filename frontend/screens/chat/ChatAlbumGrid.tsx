// screens/chat/ChatAlbumGrid.tsx
import React from "react";
import { View, Pressable, Platform, Animated, Vibration, useWindowDimensions } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  CHAT_ALBUM_GAP,
  albumGridLayout,
  getMessageImageUris,
} from "./chatAlbum";
import { WELCOME_BRAND_VI_FILL_GRADIENT } from "../home/constants";

/** Активный чекбокс альбома — как иконки активной вкладки в navbar. */
const SELECT_CHECK = WELCOME_BRAND_VI_FILL_GRADIENT[2];

type Props = {
  item: any;
  resolveMediaUri: (uri?: string) => string;
  onPressTile: (uri: string, index: number) => void;
  onLongPressTile: (uri: string, index: number) => void;
  selectionMode?: boolean;
  /** Indices of photos selected in multi-select mode. */
  selectedIndices?: number[];
  onToggleTileSelect?: (index: number) => void;
  /** @deprecated kept for API compatibility — no focus frame. */
  focusedIndex?: number | null;
};

function tapHaptic(immediate?: boolean) {
  if (Platform.OS === "ios") {
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      Vibration.vibrate(immediate ? 5 : 3);
    }
  } else {
    try {
      Vibration.vibrate(immediate ? 10 : 25);
    } catch {}
  }
}

type TileProps = {
  uri: string;
  index: number;
  messageId: string;
  width?: number;
  height?: number;
  cols: number;
  selectionMode?: boolean;
  isTileSelected?: boolean;
  onPress: () => void;
  onLongPress: () => void;
};

/** One album square — press scale only this tile, not the whole bubble. */
function AlbumTile({
  uri,
  index,
  messageId,
  width,
  height,
  cols,
  selectionMode,
  isTileSelected,
  onPress,
  onLongPress,
}: TileProps) {
  const scale = React.useRef(new Animated.Value(1)).current;
  const flexBasis = `${Math.floor(100 / cols) - 1}%` as `${number}%`;

  const runScale = React.useCallback(
    (immediate: boolean, then?: () => void) => {
      scale.stopAnimation();
      scale.setValue(1);
      Animated.sequence([
        Animated.timing(scale, {
          toValue: immediate ? 0.94 : 0.92,
          duration: immediate ? 55 : 90,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: immediate ? 130 : 140,
          useNativeDriver: true,
        }),
      ]).start();
      then?.();
    },
    [scale],
  );

  return (
    <Animated.View
      style={{
        width: width || undefined,
        height: height || undefined,
        aspectRatio: height ? undefined : 1,
        flexGrow: width ? 0 : 1,
        flexBasis: width ? undefined : flexBasis,
        borderRadius: 8,
        overflow: "hidden",
        backgroundColor: "rgba(255,255,255,0.08)",
        transform: [{ scale }],
      }}
    >
      <Pressable
        onPress={() => {
          tapHaptic(false);
          runScale(false, onPress);
        }}
        onLongPress={
          selectionMode
            ? undefined
            : () => {
                tapHaptic(true);
                runScale(true, onLongPress);
              }
        }
        delayLongPress={280}
        style={({ pressed }) => ({
          width: "100%",
          height: "100%",
          borderRadius: 8,
          overflow: "hidden",
          opacity: pressed ? 0.94 : 1,
        })}
      >
        <ExpoImage
          source={{ uri }}
          style={{ width: "100%", height: "100%" }}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={0}
          priority="high"
          recyclingKey={`album_${messageId}_${index}`}
          allowDownscaling
        />
        {selectionMode ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 5,
              right: 5,
              width: 20,
              height: 20,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: isTileSelected
                ? SELECT_CHECK
                : "rgba(0,0,0,0.40)",
              borderWidth: 1.5,
              borderColor: isTileSelected
                ? SELECT_CHECK
                : "rgba(255,255,255,0.70)",
            }}
          >
            {isTileSelected ? (
              <Ionicons name="checkmark" size={13} color="#FFFFFF" />
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Equal-tile album grid. Pixel size is locked from window width so Yoga
 * never does a second pass (estimate → onLayout shrink → jump right/down).
 */
export function ChatAlbumGrid({
  item,
  resolveMediaUri,
  onPressTile,
  onLongPressTile,
  selectionMode,
  selectedIndices = [],
  onToggleTileSelect,
}: Props) {
  const uris = React.useMemo(() => getMessageImageUris(item), [item]);
  const { width: windowWidth } = useWindowDimensions();
  const layout = albumGridLayout(windowWidth, uris.length);
  const selectedSet = React.useMemo(() => new Set(selectedIndices), [selectedIndices]);
  const messageId = String(item?.id || "img");

  return (
    <View
      collapsable={false}
      style={{
        width: layout.gridW,
        height: layout.gridH,
        overflow: "hidden",
        flexDirection: "row",
        flexWrap: "wrap",
        gap: CHAT_ALBUM_GAP,
      }}
    >
      {uris.map((raw, index) => {
        const uri = resolveMediaUri(raw) || raw;
        return (
          <AlbumTile
            key={`${messageId}-${index}-${raw.slice(-24)}`}
            messageId={messageId}
            uri={uri}
            index={index}
            width={layout.tile}
            height={layout.rowH}
            cols={layout.cols}
            selectionMode={!!selectionMode}
            isTileSelected={selectedSet.has(index)}
            onPress={() => {
              if (selectionMode) {
                onToggleTileSelect?.(index);
                return;
              }
              onPressTile(uri, index);
            }}
            onLongPress={() => onLongPressTile(uri, index)}
          />
        );
      })}
    </View>
  );
}
