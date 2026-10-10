import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AvatarImage, {
  activeFrameOutset,
  type AvatarDisplay,
} from '../../components/AvatarImage';
import { getCurrentUserId } from '../../sockets/socket';
import { CHROME_PERIMETER_GLOW_LAYOUT_INSET, LIVI } from './constants';
import { ChromePerimeterGlow } from './chrome';
import {
  AvatarDustHide,
  avatarDustSourceKey,
  type AvatarDustController,
  type AvatarDustSource,
} from './AvatarDust';
import { displayAvatarLetter, displayName } from './friendHelpers';
import type { HomeStyles } from './styles';
import { useUserActiveFrame } from '../../utils/cosmetics';


function isDirectAvatarUri(uri: string): boolean {
  return !!uri && (/^data:image\//i.test(uri) || /^https?:\/\//i.test(uri));
}

/**
 * У пользователя есть фото: версия на сервере или готовая ссылка. Локальный
 * файл только что выбранного фото сюда не входит — он ещё загружается.
 */
export function hasProfilePhoto(avatarUri: string, myAvatarVer: number): boolean {
  return (!!getCurrentUserId() && myAvatarVer > 0) || isDirectAvatarUri(avatarUri);
}

export type HomeCenterProfileProps = {
  styles: HomeStyles;
  isDark: boolean;
  layoutWidth: number;
  compact?: boolean;
  /** Телефон в landscape: та же вертикальная структура, меньший аватар/ник. */
  dense?: boolean;
  /** Экран приветствия: аватар в радаре без ника под фото. */
  radarStage?: boolean;
  /** Явный диаметр аватара на radar (иначе layoutWidth → 112/124). */
  radarAvatarSize?: number;
  savedNick: string;
  avatarUri: string;
  myFullAvatarUri: string;
  myAvatarVer: number;
  resolvedAvatarUri: string;
  resolvedAvatarReady: boolean;
  avatarVerChecked: boolean;
  menuChromeBg: string;
  onOpenAvatarModal: (uri: string) => void;
  /** Splash: onLoad аватара на радаре Поиска. */
  onSearchAvatarDecoded?: () => void;
  avatarAnchorRef?: React.Ref<View>;
  /**
   * Радар Поиска: аватар рассыпается под пальцем. Тап тогда ловит жест
   * радара, а сюда приходит только, что спрятать и из чего строить текстуру.
   */
  avatarDust?: AvatarDustController;
  onAvatarDustSource?: (source: AvatarDustSource | null) => void;
};

function HomeCenterProfileInner({
  styles,
  isDark,
  layoutWidth,
  compact = false,
  dense = false,
  radarStage = false,
  radarAvatarSize,
  savedNick,
  avatarUri,
  myFullAvatarUri,
  myAvatarVer,
  resolvedAvatarUri,
  resolvedAvatarReady,
  avatarVerChecked,
  menuChromeBg,
  onOpenAvatarModal,
  onSearchAvatarDecoded,
  avatarAnchorRef,
  avatarDust,
  onAvatarDustSource,
}: HomeCenterProfileProps) {
  const letter = displayAvatarLetter(savedNick);
  const wrapperStyle: StyleProp<ViewStyle> = {
    alignItems: 'center',
    marginTop: radarStage
      ? 0
      : dense
        ? 2
        : compact
          ? 4
          : Platform.OS === 'android'
            ? 20
            : 12 + 20,
    marginBottom: radarStage ? 0 : dense ? -8 : compact ? -18 : layoutWidth < 400 ? -40 : -65,
  };

  const isLocalPreview =
    !radarStage &&
    !!avatarUri &&
    /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
  const hasDirectAvatarUri = isDirectAvatarUri(avatarUri);
  const myUserId = getCurrentUserId();
  const activeFrameId = useUserActiveFrame(myUserId);
  const noAvatar = !isLocalPreview && !hasProfilePhoto(avatarUri, myAvatarVer);
  const noNick = !(savedNick && String(savedNick).trim());

  // Размер радара Поиска стабилен уже в HomeWelcomeView (лок на геометрию окна).
  const centerAvatarSize = radarStage
    ? Math.round(radarAvatarSize ?? (layoutWidth < 400 ? 112 : 124))
    : dense
      ? 56
      : compact
        ? 76
        : Platform.OS === 'ios'
          ? 136
          : 120;
  const centerAvatarRadius = centerAvatarSize / 2;
  // Фото всегда одного диаметра — наличие рамки не меняет layout и орбиты.
  // Рамка рисуется снаружи через overflow: visible.
  const frameOutset = activeFrameOutset(centerAvatarSize, activeFrameId);
  const centerAvatarFrameSize = Math.round(centerAvatarSize) + frameOutset * 2;
  const centerAvatarContainerSize = centerAvatarSize;
  const letterFontSize = dense ? 22 : radarStage ? 36 : 48;
  // Предпочитаем file: — иначе после splash props прыгают file→data и ExpoImage
  // перезагружается (логи: uriKind data при displayKind file, size 120→114).
  const centerAvatarUri = (() => {
    if (isLocalPreview) return resolvedAvatarUri || avatarUri || undefined;
    const candidates = [
      myFullAvatarUri,
      resolvedAvatarReady ? resolvedAvatarUri : '',
      avatarUri,
    ]
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    const file = candidates.find((u) => /^file:/i.test(u));
    if (file) return file;
    const nonData = candidates.find((u) => !/^data:/i.test(u));
    if (nonData) return nonData;
    return candidates[0] || undefined;
  })();

  const [avatarDisplay, setAvatarDisplay] = useState<AvatarDisplay>({ kind: 'empty' });
  const handleAvatarDisplay = useCallback((next: AvatarDisplay) => {
    setAvatarDisplay((prev) =>
      prev.kind === next.kind &&
      (prev.kind !== 'image' || next.kind !== 'image' || prev.uri === next.uri)
        ? prev
        : next,
    );
  }, []);

  // Ветки те же, что в разметке ниже: текстура должна совпасть с тем, что видно.
  const dustSource = useMemo((): AvatarDustSource | null => {
    if (!avatarDust || !radarStage || isLocalPreview) return null;
    const size = centerAvatarSize;
    const snapshot: AvatarDustSource = {
      kind: 'snapshot',
      size,
      key: `${letter}|${menuChromeBg}`,
    };
    const photo = (uri: string): AvatarDustSource => {
      return {
        kind: 'photo',
        uri,
        size,
        backdrop: menuChromeBg,
      };
    };
    const usesAvatarImage = !!myUserId && (!!activeFrameId || myAvatarVer > 0);
    if (usesAvatarImage) {
      if (avatarDisplay.kind === 'image') return photo(avatarDisplay.uri);
      // Снимок родителя включил бы рамку в пиксели. Для редкого fallback с
      // рамкой жест не запускаем, пока не появится настоящая фотография.
      if (avatarDisplay.kind === 'letter') return activeFrameId ? null : snapshot;
      return null;
    }
    if (hasDirectAvatarUri && resolvedAvatarReady) return photo(resolvedAvatarUri);
    return avatarVerChecked ? snapshot : null;
  }, [
    activeFrameId,
    avatarDisplay,
    avatarDust,
    avatarVerChecked,
    centerAvatarSize,
    hasDirectAvatarUri,
    isLocalPreview,
    letter,
    menuChromeBg,
    myAvatarVer,
    myUserId,
    radarStage,
    resolvedAvatarReady,
    resolvedAvatarUri,
  ]);
  const dustSourceKey = avatarDustSourceKey(dustSource);
  useEffect(() => {
    onAvatarDustSource?.(dustSource);
    // Ключ описывает источник целиком; сам объект пересоздаётся при любом рендере зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dustSourceKey, onAvatarDustSource]);
  const reportAvatarDisplay = avatarDust && radarStage ? handleAvatarDisplay : undefined;
  const avatarImageHandlesDustVisibility =
    !!myUserId && (!!activeFrameId || myAvatarVer > 0);

  // Фото без AvatarImage (только что выбранное или прямая ссылка) — тоже под линзой.
  const plainPhotoUri =
    myUserId && activeFrameId
      ? ''
      : isLocalPreview
        ? resolvedAvatarUri || avatarUri
        : myUserId && myAvatarVer > 0
          ? ''
          : hasDirectAvatarUri && resolvedAvatarReady
            ? resolvedAvatarUri
            : '';

  const avatarInner = (
    <View
      ref={avatarAnchorRef}
      collapsable={false}
      style={[
        styles.centerAvatarWrap,
        {
          width: centerAvatarContainerSize,
          height: centerAvatarContainerSize,
          borderRadius: centerAvatarContainerSize / 2,
          backgroundColor: menuChromeBg,
          overflow: activeFrameId ? 'visible' : 'hidden',
        },
      ]}
    >
      {myUserId && activeFrameId ? (
        <AvatarImage
          key={`avatar-center-${myUserId}`}
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={centerAvatarUri}
          size={centerAvatarSize}
          frameSize={centerAvatarFrameSize}
          frameId={activeFrameId}
          fallbackText={letter}
          containerStyle={styles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: letterFontSize, fontWeight: '800' }}
          onDisplayLoad={radarStage ? onSearchAvatarDecoded : undefined}
          onDisplayChange={reportAvatarDisplay}
          displayHidden={avatarDust?.realHidden}
        />
      ) : isLocalPreview ? (
        plainPhotoUri ? (
          <ExpoImage
            source={{ uri: plainPhotoUri }}
            style={styles.centerAvatarImg}
            cachePolicy="none"
            onLoad={radarStage ? onSearchAvatarDecoded : undefined}
          />
        ) : null
      ) : myUserId && myAvatarVer > 0 ? (
        <AvatarImage
          key={`avatar-center-${myUserId}`}
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={centerAvatarUri}
          size={centerAvatarSize}
          frameId={activeFrameId || null}
          fallbackText={letter}
          containerStyle={styles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: letterFontSize, fontWeight: '800' }}
          onDisplayLoad={radarStage ? onSearchAvatarDecoded : undefined}
          onDisplayChange={reportAvatarDisplay}
          displayHidden={avatarDust?.realHidden}
        />
      ) : hasDirectAvatarUri && resolvedAvatarReady ? (
        plainPhotoUri ? (
          <ExpoImage
            source={{ uri: plainPhotoUri }}
            style={styles.centerAvatarImg}
            cachePolicy={/^https?:\/\//i.test(avatarUri) ? 'memory-disk' : 'none'}
            onLoad={radarStage ? onSearchAvatarDecoded : undefined}
          />
        ) : null
      ) : hasDirectAvatarUri ? (
        avatarVerChecked ? (
          <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: LIVI.titan, fontSize: letterFontSize, fontWeight: '500' }}>{letter}</Text>
          </View>
        ) : (
          <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
        )
      ) : avatarVerChecked ? (
        <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={{ color: LIVI.titan, fontSize: letterFontSize, fontWeight: '500' }}>{letter}</Text>
        </View>
      ) : (
        <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
      )}
    </View>
  );

  return (
    <View style={wrapperStyle}>
      {avatarDust && radarStage ? (
        <View style={{ alignSelf: 'center' }}>
          {avatarImageHandlesDustVisibility ? (
            avatarInner
          ) : (
            <AvatarDustHide dust={avatarDust}>{avatarInner}</AvatarDustHide>
          )}
        </View>
      ) : (
      <Pressable
        onPress={() => onOpenAvatarModal(myFullAvatarUri || avatarUri || '')}
        style={{ alignSelf: 'center' }}
      >
        {radarStage || activeFrameId ? (
          avatarInner
        ) : (
          <ChromePerimeterGlow
            isDark={isDark}
            width={centerAvatarSize}
            height={centerAvatarSize}
            borderRadius={centerAvatarRadius}
            glowIntensity={isDark ? 1.15 : 2.25}
            outerStyle={{ marginBottom: -CHROME_PERIMETER_GLOW_LAYOUT_INSET }}
          >
            {avatarInner}
          </ChromePerimeterGlow>
        )}
      </Pressable>
      )}
      {!radarStage ? (
      <Text
        style={[
          styles.subtitleNik,
          {
            marginTop: dense ? 4 : compact ? 6 : 12,
            fontSize: dense ? 14 : compact ? 16 : Platform.OS === 'ios' ? 25 : 20,
            color: noNick || noAvatar ? LIVI.titan : isDark ? LIVI.text2 : LIVI.textThemeWhite,
          },
        ]}
        numberOfLines={dense ? 1 : undefined}
        ellipsizeMode={dense ? 'tail' : undefined}
      >
        {displayName(savedNick)}
      </Text>
      ) : null}
    </View>
  );
}

export const HomeCenterProfile = React.memo(HomeCenterProfileInner);
