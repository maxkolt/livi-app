// screens/chat/ChatAlbumGrid.tsx
import React from "react";
import { View, Pressable, Platform, Animated, Vibration } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  CHAT_ALBUM_GAP,
  CHAT_ALBUM_INSET,
  albumGridColumns,
  getMessageImageUris,
} from "./chatAlbum";

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
  width?: number;
  height?: number;
  cols: number;
  tileMeasured: boolean;
  selectionMode?: boolean;
  isTileSelected?: boolean;
  onPress: () => void;
  onLongPress: () => void;
};

/** One album square — press scale only this tile, not the whole bubble. */
function AlbumTile({
  uri,
  index,
  width,
  height,
  cols,
  tileMeasured,
  selectionMode,
  isTileSelected,
  onPress,
  onLongPress,
}: TileProps) {
  const scale = React.useRef(new Animated.Value(1)).current;

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
        aspectRatio: tileMeasured ? undefined : 1,
        flexGrow: tileMeasured ? 0 : 1,
        flexBasis: tileMeasured ? undefined : `${Math.floor(100 / cols) - 1}%`,
        borderRadius: 8,
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
          backgroundColor: "rgba(255,255,255,0.08)",
        })}
      >
        {tileMeasured ? (
          <ExpoImage
            source={{ uri }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={Platform.OS === "android" ? 0 : 160}
            recyclingKey={`album_tile_${index}_${uri.slice(-20)}`}
            allowDownscaling
          />
        ) : null}
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
                ? "rgba(85,209,135,0.95)"
                : "rgba(0,0,0,0.40)",
              borderWidth: 1.5,
              borderColor: isTileSelected
                ? "#55d187"
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
 * Equal-tile album grid. Parent bubble supplies side/top padding;
 * this grid fills 100% of that content box so tiles never overflow.
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
  const cols = albumGridColumns(uris.length);
  const [innerW, setInnerW] = React.useState(0);
  const selectedSet = React.useMemo(() => new Set(selectedIndices), [selectedIndices]);

  const tile =
    innerW > 0
      ? Math.max(1, Math.floor((innerW - CHAT_ALBUM_GAP * (cols - 1)) / cols))
      : 0;
  const rowH = uris.length === 1 ? Math.round(tile * 0.78) : tile;

  return (
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
        return (
          <AlbumTile
            key={`${item?.id || "img"}-${index}-${raw.slice(-24)}`}
            uri={uri}
            index={index}
            width={tile || undefined}
            height={tile ? rowH : undefined}
            cols={cols}
            tileMeasured={tile > 0}
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

export { CHAT_ALBUM_INSET };
