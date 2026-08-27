import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop as SvgStop,
  Text as SvgText,
} from 'react-native-svg';
import {
  ANIMATED_BORDER_WIDTH,
  SEARCH_CTA_MAX_WIDTH,
  SEARCH_CTA_TABLET_MAX_WIDTH,
  SEARCH_CTA_TABLET_MIN_WIDTH,
  BRAND_3D_LAYERS,
  BRAND_3D_STEP_X,
  BRAND_3D_STEP_Y,
  BRAND_FONT_FAMILY,
  BRAND_LETTER_GLOW_INSET,
  BRAND_LETTER_GLOW_INTENSITY,
  BRAND_LETTER_GLOW_LAYERS,
  BRAND_LETTER_GLOW_OVERLAP,
  BRAND_LETTER_GLOW_SPREAD,
  BRAND_OUTLINE_STROKE,
  CHROME_PERIMETER_GLOW_LAYERS,
  CHROME_PERIMETER_GLOW_SPREAD,
  LIVI,
} from './constants';
import { styles } from './styles';

/* ================= Animated gradient border (кнопка «Начать поиск», меню) ================= */

/** Статичные цвета обводки (аватар профиля и т.п.) — те же, что у CTA/меню. */
export const CHROME_BORDER_GRADIENT_DARK = [
  '#14b8a6',
  '#3b82f6',
  '#00b5ff',
  '#FFF8F0',
] as const;
export const CHROME_BORDER_GRADIENT_LIGHT = [
  '#8f7ad8',
  '#FFF8F0',
  '#B0B5BF',
] as const;

/** Тёмная рамка аватара — жемчуг понемногу с обеих диагоналей. */
export const AVATAR_CHROME_GRADIENT_DARK = [
  '#FFF8F0',
  '#14b8a6',
  '#3b82f6',
  '#00b5ff',
  '#FFF8F0',
] as const;

/** Светлая рамка аватара — чуть больше фиолетового, чем у CTA. */
export const AVATAR_CHROME_GRADIENT_LIGHT = [
  '#9a7ad8',
  '#e8def2',
  '#b8b0cc',
  '#9b78d8',
] as const;

const EQUALIZER_GRADIENT_DARK = [
  ...CHROME_BORDER_GRADIENT_DARK,
  ...CHROME_BORDER_GRADIENT_DARK,
];
const EQUALIZER_GRADIENT_LIGHT = [
  ...CHROME_BORDER_GRADIENT_LIGHT,
  ...CHROME_BORDER_GRADIENT_LIGHT,
];

function chromeExtrudeFill(layer: number, layerCount: number, isDark: boolean): string {
  const depth = layer / layerCount;
  if (isDark) {
    return `rgba(6, 10, 18, ${0.2 + depth * 0.38})`;
  }
  return `rgba(28, 32, 40, ${0.16 + depth * 0.32})`;
}

function chromePerimeterGlowFill(
  layer: number,
  layerCount: number,
  isDark: boolean,
  intensity = 1
): string {
  const falloff = (layerCount - layer + 1) / layerCount;
  if (isDark) {
    const alpha = (0.012 + falloff * 0.042) * intensity;
    return `rgba(0, 0, 0, ${alpha})`;
  }
  const alpha = (0.005 + falloff * 0.018) * intensity;
  return `rgba(16, 20, 28, ${alpha})`;
}

type ChromePerimeterGlowProps = {
  isDark: boolean;
  width: number;
  height: number;
  borderRadius: number;
  outerStyle?: StyleProp<ViewStyle>;
  glowLayers?: number;
  glowSpread?: number;
  glowIntensity?: number;
  children: React.ReactNode;
};

export const ChromePerimeterGlow: React.FC<ChromePerimeterGlowProps> = ({
  isDark,
  width,
  height,
  borderRadius,
  outerStyle,
  glowLayers: glowLayerCount = CHROME_PERIMETER_GLOW_LAYERS,
  glowSpread = CHROME_PERIMETER_GLOW_SPREAD,
  glowIntensity = 1,
  children,
}) => {
  const maxGlowSpread = glowLayerCount * glowSpread;
  const glowLayers = Array.from(
    { length: glowLayerCount },
    (_, idx) => glowLayerCount - idx
  );

  return (
    <Animated.View
      style={[
        {
          width: width + maxGlowSpread * 2,
          height: height + maxGlowSpread * 2,
        },
        outerStyle,
      ]}
    >
      {glowLayers.map((layer) => {
        const spread = layer * glowSpread;
        return (
          <View
            key={`chrome-glow-${layer}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: maxGlowSpread - spread,
              top: maxGlowSpread - spread,
              width: width + spread * 2,
              height: height + spread * 2,
              borderRadius: borderRadius + spread * 0.55,
              backgroundColor: chromePerimeterGlowFill(
                layer,
                glowLayerCount,
                isDark,
                glowIntensity
              ),
            }}
          />
        );
      })}
      <View
        style={{
          position: 'absolute',
          left: maxGlowSpread,
          top: maxGlowSpread,
          ...(Platform.OS === 'ios'
            ? {
                shadowColor: isDark ? '#000000' : '#141820',
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: (isDark ? 0.12 : 0.045) * glowIntensity,
                shadowRadius: 16,
              }
            : null),
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
};

type AnimatedGradientBorderProps = {
  isDark: boolean;
  width: number;
  height: number;
  borderRadius?: number;
  borderWidth?: number;
  outerStyle?: StyleProp<ViewStyle>;
  innerStyle?: StyleProp<ViewStyle>;
  perimeterGlow?: boolean;
  children: React.ReactNode;
};

export const AnimatedGradientBorder: React.FC<AnimatedGradientBorderProps> = ({
  isDark,
  width,
  height,
  borderRadius = 12,
  borderWidth = ANIMATED_BORDER_WIDTH,
  outerStyle,
  innerStyle,
  perimeterGlow = false,
  children,
}) => {
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const colors = isDark ? EQUALIZER_GRADIENT_DARK : EQUALIZER_GRADIENT_LIGHT;

  useEffect(() => {
    rotateAnim.setValue(0);
    const rotateAnimation = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 3000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      { iterations: -1 }
    );
    rotateAnimation.start();
    return () => {
      rotateAnimation.stop();
      rotateAnim.stopAnimation();
    };
  }, [rotateAnim]);

  const rotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const outerW = width + borderWidth * 2;
  const outerH = height + borderWidth * 2;
  const gradientSize = Math.max(width, height) * 2;
  const outerRadius = borderRadius + borderWidth;

  const chromeBody = (
    <Animated.View
      style={[
        {
          width: outerW,
          height: outerH,
          borderRadius: outerRadius,
          overflow: 'hidden',
          ...(Platform.OS === 'android' && !isDark
            ? {
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: 'rgba(138, 143, 153, 0.3)',
              }
            : {}),
        },
        !perimeterGlow ? outerStyle : undefined,
      ]}
    >
      <Animated.View
        style={{
          position: 'absolute',
          width: gradientSize,
          height: gradientSize,
          left: (outerW - gradientSize) / 2,
          top: (outerH - gradientSize) / 2,
          transform: [{ rotate }],
        }}
      >
        <LinearGradient
          colors={colors as unknown as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: '100%', height: '100%' }}
        />
      </Animated.View>
      <View
        style={[
          {
            position: 'absolute',
            top: borderWidth,
            left: borderWidth,
            right: borderWidth,
            bottom: borderWidth,
            borderRadius,
            overflow: 'hidden',
          },
          innerStyle,
        ]}
      >
        {children}
      </View>
    </Animated.View>
  );

  if (!perimeterGlow) {
    return chromeBody;
  }

  return (
    <ChromePerimeterGlow
      isDark={isDark}
      width={outerW}
      height={outerH}
      borderRadius={outerRadius}
      outerStyle={outerStyle}
    >
      {chromeBody}
    </ChromePerimeterGlow>
  );
};

const BrandStrokeGradientDefs: React.FC<{ gradId: string; isDark: boolean }> = ({
  gradId,
  isDark,
}) => {
  const colors = isDark ? EQUALIZER_GRADIENT_DARK : EQUALIZER_GRADIENT_LIGHT;
  return (
    <Defs>
      <SvgLinearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
        <SvgStop offset="0%" stopColor={colors[0]} />
        <SvgStop offset="35%" stopColor={colors[1]} />
        <SvgStop offset="65%" stopColor={colors[2]} />
        <SvgStop offset="100%" stopColor={colors[3]} />
      </SvgLinearGradient>
    </Defs>
  );
};

const Brand3dFaceGradientDefs: React.FC<{ gradId: string; isDark: boolean }> = ({
  gradId,
  isDark,
}) => (
  <Defs>
    {isDark ? (
      <SvgLinearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
        <SvgStop offset="0%" stopColor="#C5CDDC" />
        <SvgStop offset="48%" stopColor="#AEB6C6" />
        <SvgStop offset="100%" stopColor="#7A8496" />
      </SvgLinearGradient>
    ) : (
      <SvgLinearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
        <SvgStop offset="0%" stopColor="#5C5C5C" />
        <SvgStop offset="48%" stopColor="#444444" />
        <SvgStop offset="100%" stopColor="#2E2E2E" />
      </SvgLinearGradient>
    )}
  </Defs>
);

const BRAND_LETTERS = ['L', 'i', 'V', 'i'] as const;
const BRAND_LETTER_GRAD_SUFFIX = ['L', 'I1', 'V', 'I2'] as const;

type BrandLetterWithOutlineAndGlowProps = {
  letter: string;
  letterIndex: number;
  isDark: boolean;
  strokeGradId: string;
  fillGradId: string;
  shineNonce?: number;
  pressLocked?: boolean;
};

const BrandLetterWithOutlineAndGlow: React.FC<BrandLetterWithOutlineAndGlowProps> = ({
  letter,
  letterIndex,
  isDark,
  strokeGradId,
  fillGradId,
  shineNonce = 0,
  pressLocked = false,
}) => {
  const [textSize, setTextSize] = useState({
    w: letter === 'i' ? 14 : 26,
    h: 40,
  });
  const [shineShift, setShineShift] = useState(0);
  const [shineOp, setShineOp] = useState(0);
  const shineX = useRef(new Animated.Value(0)).current;
  const shineOpacity = useRef(new Animated.Value(0)).current;
  const stroke = BRAND_OUTLINE_STROKE;
  const pad = stroke;
  const extrudeX = BRAND_3D_LAYERS * BRAND_3D_STEP_X;
  const extrudeY = BRAND_3D_LAYERS * BRAND_3D_STEP_Y;
  const svgW = textSize.w + pad * 2 + extrudeX;
  const svgH = textSize.h + pad * 2 + extrudeY;
  const fontSize = 41;
  const fontWeight = '600';
  const baselineY =
    pad + textSize.h - (Platform.OS === 'ios' ? 3 : 4);
  const shineGradId = `liviBrandShine${BRAND_LETTER_GRAD_SUFFIX[letterIndex]}`;
  const shineSweepW = Math.max(18, textSize.w * 0.85);

  const brandSvgTextLayout = {
    fontSize,
    fontWeight,
    fontFamily: BRAND_FONT_FAMILY,
    letterSpacing: 0,
    x: pad,
    y: baselineY,
  };

  const extrusionLayers = Array.from(
    { length: BRAND_3D_LAYERS },
    (_, idx) => BRAND_3D_LAYERS - idx
  );
  const glowRadius = Math.min(14, svgH * 0.26, svgW * 0.42);
  const letterGlowOverlap = BRAND_LETTER_GLOW_INSET * BRAND_LETTER_GLOW_OVERLAP;

  useEffect(() => {
    const xId = shineX.addListener(({ value }) => setShineShift(value));
    const oId = shineOpacity.addListener(({ value }) => setShineOp(value));
    return () => {
      shineX.removeListener(xId);
      shineOpacity.removeListener(oId);
    };
  }, [shineOpacity, shineX]);

  useEffect(() => {
    if (pressLocked) {
      shineOpacity.setValue(0);
      setShineOp(0);
    }
  }, [pressLocked, shineOpacity]);

  useEffect(() => {
    if (!shineNonce) return;
    const startX = pad - shineSweepW;
    const endX = pad + textSize.w + 4;
    shineX.setValue(startX);
    shineOpacity.setValue(0);
    setShineShift(startX);
    setShineOp(0);
    Animated.sequence([
      Animated.delay(letterIndex * 190),
      Animated.timing(shineOpacity, {
        toValue: 1,
        duration: 110,
        useNativeDriver: false,
      }),
      Animated.parallel([
        Animated.timing(shineX, {
          toValue: endX,
          duration: 980,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: false,
        }),
        Animated.sequence([
          Animated.delay(680),
          Animated.timing(shineOpacity, {
            toValue: 0,
            duration: 320,
            useNativeDriver: false,
          }),
        ]),
      ]),
    ]).start();
  }, [
    letterIndex,
    pad,
    shineNonce,
    shineOpacity,
    shineSweepW,
    shineX,
    textSize.w,
  ]);

  return (
    <ChromePerimeterGlow
      isDark={isDark}
      width={svgW}
      height={svgH}
      borderRadius={glowRadius}
      glowLayers={BRAND_LETTER_GLOW_LAYERS}
      glowSpread={BRAND_LETTER_GLOW_SPREAD}
      glowIntensity={BRAND_LETTER_GLOW_INTENSITY}
      outerStyle={{
        marginLeft: letterIndex === 0 ? -BRAND_LETTER_GLOW_INSET : -letterGlowOverlap,
        marginRight: -letterGlowOverlap,
      }}
    >
      <Text
        style={[styles.brand, styles.brandMeasureProbe]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0) {
            setTextSize({ w: width, h: height });
          }
        }}
      >
        {letter}
      </Text>
      <Svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
        <BrandStrokeGradientDefs gradId={strokeGradId} isDark={isDark} />
        <Brand3dFaceGradientDefs gradId={fillGradId} isDark={isDark} />
        {shineOp > 0.01 ? (
          <Defs>
            {/* Градиент двигается по user-space; заливка только у глифа буквы. */}
            <SvgLinearGradient
              id={shineGradId}
              gradientUnits="userSpaceOnUse"
              x1={shineShift}
              y1={0}
              x2={shineShift + shineSweepW}
              y2={0}
            >
              <SvgStop offset="0%" stopColor="#FFFFFF" stopOpacity={0} />
              <SvgStop
                offset="40%"
                stopColor={isDark ? '#FFF8F0' : '#FFFFFF'}
                stopOpacity={0.12}
              />
              <SvgStop
                offset="50%"
                stopColor={isDark ? '#FFF8F0' : '#FFFFFF'}
                stopOpacity={0.9}
              />
              <SvgStop
                offset="60%"
                stopColor={isDark ? '#00b5ff' : '#8f7ad8'}
                stopOpacity={0.28}
              />
              <SvgStop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
            </SvgLinearGradient>
          </Defs>
        ) : null}
        {extrusionLayers.map((layer) => (
          <SvgText
            key={`extrude-${letter}-${layer}`}
            {...brandSvgTextLayout}
            x={pad + layer * BRAND_3D_STEP_X}
            y={baselineY + layer * BRAND_3D_STEP_Y}
            fill={chromeExtrudeFill(layer, BRAND_3D_LAYERS, isDark)}
            stroke="none"
          >
            {letter}
          </SvgText>
        ))}
        <SvgText
          {...brandSvgTextLayout}
          fill="none"
          stroke={`url(#${strokeGradId})`}
          strokeWidth={stroke}
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          {letter}
        </SvgText>
        <SvgText
          {...brandSvgTextLayout}
          fill={`url(#${fillGradId})`}
          stroke="none"
        >
          {letter}
        </SvgText>
        {shineOp > 0.01 ? (
          <SvgText
            {...brandSvgTextLayout}
            fill={`url(#${shineGradId})`}
            stroke="none"
            opacity={shineOp}
          >
            {letter}
          </SvgText>
        ) : null}
      </Svg>
    </ChromePerimeterGlow>
  );
};

type BrandTitleWithOutlineProps = {
  isDark: boolean;
  onPress?: () => void;
  pressLocked?: boolean;
  shineNonce?: number;
};

export const BrandTitleWithOutline: React.FC<BrandTitleWithOutlineProps> = ({
  isDark,
  onPress,
  pressLocked = false,
  shineNonce = 0,
}) => {
  const letters = (
    <View
      style={styles.brandOutlineWrap}
      accessible={!onPress}
      accessibilityRole={onPress ? undefined : 'header'}
      accessibilityLabel={onPress ? undefined : 'LiVi'}
    >
      {BRAND_LETTERS.map((letter, index) => (
        <BrandLetterWithOutlineAndGlow
          key={`${letter}-${index}`}
          letter={letter}
          letterIndex={index}
          isDark={isDark}
          strokeGradId={`liviBrandGrad${BRAND_LETTER_GRAD_SUFFIX[index]}`}
          fillGradId={`liviBrandFill3d${BRAND_LETTER_GRAD_SUFFIX[index]}`}
          shineNonce={shineNonce}
          pressLocked={pressLocked}
        />
      ))}
    </View>
  );

  if (!onPress) return letters;

  return (
    <Pressable
      onPress={() => {
        if (pressLocked) return;
        onPress();
      }}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      accessibilityRole="header"
      accessibilityLabel="LiVi"
      style={{ flexShrink: 1 }}
    >
      {letters}
    </Pressable>
  );
};

/* ================= Animated Border Button Component ================= */
type AnimatedBorderButtonProps = {
  isDark: boolean;
  onPress: () => void;
  label: string;
  style?: ViewStyle;
  backgroundColor?: string; // Цвет фона страницы для перекрытия градиента
  disabled?: boolean;
  onDisabledPress?: () => void;
  /** Телефон landscape: ниже кнопка и мельче текст. */
  compact?: boolean;
};

export const AnimatedBorderButton: React.FC<AnimatedBorderButtonProps> = ({
  isDark,
  onPress,
  label,
  style,
  backgroundColor,
  disabled = false,
  onDisabledPress,
  compact = false,
}) => {
  const { width: windowWidth } = useWindowDimensions();
  const [blurIntensity, setBlurIntensity] = useState<number>(isDark ? 15 : 20);
  const titanOpacity = useRef(new Animated.Value(0.25)).current;
  const blockedFlashOpacity = useRef(new Animated.Value(0)).current;
  const blockedShakeX = useRef(new Animated.Value(0)).current;

  const titanColor = isDark ? '#8A8F99' : '#3B4453';

  const sideInset = Platform.OS === 'ios' ? 60 : 40;
  const maxCtaWidth =
    windowWidth >= SEARCH_CTA_TABLET_MIN_WIDTH ? SEARCH_CTA_TABLET_MAX_WIDTH : SEARCH_CTA_MAX_WIDTH;
  const buttonWidth = Math.min(Math.max(0, windowWidth - sideInset), maxCtaWidth);
  const buttonHeight = compact
    ? Platform.OS === 'ios'
      ? 36
      : 32
    : Platform.OS === 'ios'
      ? 52
      : 44;
  const borderRadius = 12;
  const labelFontSize = compact ? 14 : undefined;

  const pressArmedRef = useRef(false);

  const triggerBlockedFeedback = useCallback(() => {
    // Короткий визуальный "нельзя": красный пульс + мягкий шейк.
    blockedFlashOpacity.stopAnimation();
    blockedShakeX.stopAnimation();
    blockedFlashOpacity.setValue(0);
    blockedShakeX.setValue(0);

    Animated.sequence([
      Animated.parallel([
        Animated.timing(blockedFlashOpacity, {
          toValue: 1,
          duration: 130,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(blockedShakeX, { toValue: 2, duration: 60, useNativeDriver: true }),
          Animated.timing(blockedShakeX, { toValue: -2, duration: 70, useNativeDriver: true }),
          Animated.timing(blockedShakeX, { toValue: 1.5, duration: 55, useNativeDriver: true }),
          Animated.timing(blockedShakeX, { toValue: 0, duration: 65, useNativeDriver: true }),
        ]),
      ]),
      Animated.timing(blockedFlashOpacity, {
        toValue: 0,
        duration: 280,
        useNativeDriver: true,
      }),
    ]).start();
    onDisabledPress?.();
  }, [blockedFlashOpacity, blockedShakeX, onDisabledPress]);

  const firePress = useCallback(() => {
    if (disabled) {
      triggerBlockedFeedback();
      return;
    }
    if (pressArmedRef.current) return;
    pressArmedRef.current = true;
    onPress();
  }, [disabled, onPress, triggerBlockedFeedback]);

  const unlockPress = useCallback(() => {
    pressArmedRef.current = false;
  }, []);

  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]}>
      <AnimatedGradientBorder
        isDark={isDark}
        width={buttonWidth}
        height={buttonHeight}
        borderRadius={borderRadius}
        perimeterGlow
        outerStyle={{
          transform: [{ translateX: blockedShakeX }],
          shadowOpacity: 0,
          elevation: 0,
        }}
        innerStyle={{
          backgroundColor: backgroundColor || (isDark ? '#151F33' : '#8a8f99'),
        }}
      >
            {/* Эффект стекла с blur - фон страницы просвечивает через размытие */}
            <BlurView
              pointerEvents={Platform.OS === 'android' ? 'none' : 'auto'}
              intensity={blurIntensity}
              tint={isDark ? 'dark' : 'light'}
              style={{
                ...StyleSheet.absoluteFillObject,
                borderRadius: borderRadius,
              }}
            />
            {/* Титановый слой с прозрачностью - создает эффект титанового стекла */}
            <Animated.View
              pointerEvents="none"
              style={{
                ...StyleSheet.absoluteFillObject,
                borderRadius: borderRadius,
                backgroundColor: titanColor,
                opacity: disabled ? 0.18 : titanOpacity,
              }}
            />
            <Animated.View
              pointerEvents="none"
              style={{
                ...StyleSheet.absoluteFillObject,
                borderRadius: borderRadius,
                backgroundColor: 'rgba(255,90,103,0.35)',
                opacity: blockedFlashOpacity.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 0.55],
                }),
              }}
            />
            {Platform.OS === 'android' ? (
              <Pressable
                onPressIn={firePress}
                onPress={firePress}
                onPressOut={unlockPress}
                disabled={disabled}
                accessibilityState={{ disabled }}
                android_ripple={{
                  color: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
                  borderless: false,
                }}
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: borderRadius,
                  backgroundColor: 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 32,
                }}
              >
                <Text
                  style={[
                    styles.buttonLabel,
                    {
                      color: isDark ? LIVI.text : LIVI.textThemeWhite,
                      textAlign: 'center',
                      opacity: disabled ? 0.88 : 1,
                      ...(labelFontSize ? { fontSize: labelFontSize } : null),
                    },
                  ]}
                  allowFontScaling={false}
                  maxFontSizeMultiplier={1}
                >
                  {label}
                </Text>
              </Pressable>
            ) : (
              <TouchableOpacity
                activeOpacity={1}
                onPressIn={() => {
                  if (disabled) {
                    triggerBlockedFeedback();
                    return;
                  }
                  setBlurIntensity(isDark ? 25 : 40);
                  Animated.timing(titanOpacity, {
                    toValue: isDark ? 0.4 : 0.5,
                    duration: 150,
                    useNativeDriver: true,
                  }).start();
                  firePress();
                }}
                onPressOut={() => {
                  unlockPress();
                  if (disabled) return;
                  setBlurIntensity(isDark ? 15 : 20);
                  Animated.timing(titanOpacity, {
                    toValue: 0.25,
                    duration: 200,
                    useNativeDriver: true,
                  }).start();
                }}
                onPress={firePress}
                accessibilityState={{ disabled }}
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: borderRadius,
                  backgroundColor: 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 32,
                }}
              >
                <Text
                  style={[
                    styles.buttonLabel,
                    {
                      color: isDark ? LIVI.text : LIVI.textThemeWhite,
                      textAlign: 'center',
                      opacity: disabled ? 0.88 : 1,
                      ...(labelFontSize ? { fontSize: labelFontSize } : null),
                    },
                  ]}
                  allowFontScaling={false}
                  maxFontSizeMultiplier={1}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            )}
            {disabled && (
              <Pressable
                style={StyleSheet.absoluteFillObject}
                onPressIn={triggerBlockedFeedback}
                onPress={triggerBlockedFeedback}
                android_ripple={{ color: 'rgba(255,90,103,0.10)', borderless: false }}
              />
            )}
      </AnimatedGradientBorder>
    </View>
  );
};
