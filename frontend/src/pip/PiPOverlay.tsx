// src/pip/PiPOverlay.tsx
import React, { useMemo, useRef, useEffect } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  View,
  Pressable,
  Text,
  Image,
  Platform,
} from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePiP } from './PiPContext';
import VoiceEqualizer from '../../components/VoiceEqualizer';
import { logger } from '../../utils/logger';

const UI = {
  bg: 'rgba(25,32,46,0.95)',  // LiVi dark
  fg: '#E7EEF7',
  subtle: 'rgba(231,238,247,0.60)',
  accentSoft: 'rgba(113,91,168,0.18)',
  success: '#28d365',
  danger: '#FF4D4F',
  stroke: 'rgba(255,255,255,0.10)',
};

export default function PiPOverlay() {
  const {
    visible,
    callId,
    roomId,
    partnerName,
    partnerAvatarUrl,
    remoteStream,
    localStream,
    isMuted,
    isRemoteMuted,
    returnToCall,
    toggleMic,
    toggleRemoteAudio,
    endCall,
    pipPos,
    updatePiPPosition,
    micLevel,
  } = usePiP();

  const insets = useSafeAreaInsets();
  const { width: W, height: H } = Dimensions.get('window');


  // размеры вертикальной карточки
  const PIP_W = 148;
  const PIP_H = 232;
  const PAD = 12;

  const MIN_X = PAD + insets.left;
  const MIN_Y = PAD + insets.top;
  const MAX_X = W - PIP_W - PAD - insets.right;
  const MAX_Y = H - PIP_H - PAD - insets.bottom;

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));

  const translate = useRef(
    new Animated.ValueXY({
      x: clamp(pipPos.x, MIN_X, MAX_X),
      y: clamp(pipPos.y, MIN_Y, MAX_Y),
    })
  ).current;
  const start = useRef({ x: 0, y: 0 });
  const pulse = useRef(new Animated.Value(0)).current;

  // ✨ ВАЖНО: не перехватываем тапы — начинаем pan только при явном сдвиге
  const DRAG_THRESHOLD = 6;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD,
        onPanResponderGrant: () => {
          // @ts-ignore
          start.current = { x: translate.x.__getValue(), y: translate.y.__getValue() };
        },
        onPanResponderMove: (_e, g) => {
          const nx = clamp(start.current.x + g.dx, MIN_X, MAX_X);
          const ny = clamp(start.current.y + g.dy, MIN_Y, MAX_Y);
          translate.setValue({ x: nx, y: ny });
        },
        onPanResponderRelease: (_e, g) => {
          // «тап без движения» — считаем нажатием по карточке
          if (Math.abs(g.dx) < DRAG_THRESHOLD && Math.abs(g.dy) < DRAG_THRESHOLD) {
            returnToCall();
            return;
          }
          const nx = clamp(start.current.x + g.dx, MIN_X, MAX_X);
          const ny = clamp(start.current.y + g.dy, MIN_Y, MAX_Y);
          const snapLeft = Math.abs(nx - MIN_X) < Math.abs(nx - MAX_X);
          const snapX = snapLeft ? MIN_X : MAX_X;
          Animated.spring(translate, {
            toValue: { x: snapX, y: ny },
            useNativeDriver: false,
            bounciness: 6,
            speed: 12,
          }).start(() => updatePiPPosition(snapX, ny));
        },
      }),
    [MIN_X, MAX_X, MIN_Y, MAX_Y, translate, updatePiPPosition, returnToCall]
  );

  // ограничение при смене ориентации
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      const maxX = window.width - PIP_W - PAD - insets.right;
      const maxY = window.height - PIP_H - PAD - insets.bottom;
      updatePiPPosition(
        clamp(pipPos.x, MIN_X, maxX),
        clamp(pipPos.y, MIN_Y, maxY)
      );
    });
    return () => sub?.remove?.();
  }, [pipPos.x, pipPos.y, insets.right, insets.bottom, MIN_X, MIN_Y, updatePiPPosition]);

  // VAD отключен - анимация пульса не используется

  // Убрали избыточное логирование для уменьшения шума

  // КРИТИЧНО: Логируем показ PiP для отладки (до проверки visible)
  useEffect(() => {
    if (visible) {
      logger.info('[PiPOverlay] ✅ Показываем PiP оверлей', {
        visible,
        callId,
        roomId,
        partnerName,
        hasRemoteStream: !!remoteStream,
        hasLocalStream: !!localStream
      });
    }
  }, [visible, callId, roomId, partnerName, remoteStream, localStream]);
  
  // ВАЖНО: Все хуки должны вызываться до раннего возврата
  // Если visible === false, возвращаем null, но только после всех хуков
  if (!visible) {
    return null;
  }

  // Проверяем валидность URL аватара
  const hasValidAvatar = partnerAvatarUrl && 
    typeof partnerAvatarUrl === 'string' &&
    partnerAvatarUrl.trim() !== '' && 
    (partnerAvatarUrl.startsWith('http') || partnerAvatarUrl.startsWith('data:'));

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        { width: PIP_W, height: PIP_H, transform: [{ translateX: translate.x }, { translateY: translate.y }] },
      ]}
      {...panResponder.panHandlers}
    >
      {/* КРИТИЧНО: Убрали скрытый RTCView, так как он может конфликтовать с основным отображением видео
          и потреблять ресурсы стрима. Если нужен для какой-то цели, можно вернуть, но лучше избегать
          множественных RTCView для одного стрима */}

      <View style={styles.card}>
        {/* header (нажатие по шапке = вернуться в звонок) */}
        <Pressable style={styles.header} onPress={returnToCall} android_ripple={{ borderless: true, color: 'rgba(255,255,255,0.1)' }}>
          <View style={styles.avatarWrap}>
            {/* VAD отключен - пульсирующее кольцо не показывается */}
            {hasValidAvatar ? (
              <Image 
                source={{ uri: partnerAvatarUrl! }} 
                style={styles.avatarImg}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.avatarFallback}>
                <MaterialIcons name="person" size={22} color={UI.fg} />
              </View>
            )}
          </View>
          <Text numberOfLines={1} style={styles.name}>{partnerName || 'Собеседник'}</Text>
          <View style={styles.statusRow}>
            <View style={styles.dot} />
            <Text style={styles.status}>вызов активен</Text>
          </View>
        </Pressable>

        {/* Эквалайзер посередине между надписью и кнопками */}
        <View style={styles.eqWrapper}>
          <VoiceEqualizer
            level={!isMuted ? micLevel : 0}
            width={40}
            height={30}
            bars={7}
            gap={5}
            minLine={1}
            threshold={0.01}
            sensitivity={2.0}
            colors={["#F4FFFF", "#2EE6FF", "#F4FFFF"]}
          />
        </View>

        {/* actions */}
        <View style={styles.actions}>
          {/* MUTE */}
          <Pressable
            onPress={toggleMic}
            android_ripple={Platform.OS === 'android' ? { color: 'rgba(255,255,255,0.12)', radius: 20 } : undefined}
            style={({ pressed }) => [
              Platform.OS === 'android' ? styles.btnSq : styles.btn,
              Platform.OS === 'android' ? styles.btnOutline : null,
              Platform.OS === 'android' && isMuted ? styles.btnOutlineDanger : null,
              Platform.OS === 'android' && pressed ? styles.btnPressed : null,
              Platform.OS !== 'android' && isMuted ? styles.btnDanger : null,
            ]}
          >
            <MaterialIcons
              name={isMuted ? 'mic-off' : 'mic'}
              size={18}
              color={isMuted ? UI.danger : UI.fg}
            />
          </Pressable>

          {/* SPEAKER */}
          <Pressable
            onPress={toggleRemoteAudio}
            android_ripple={Platform.OS === 'android' ? { color: 'rgba(255,255,255,0.12)', radius: 20 } : undefined}
            style={({ pressed }) => [
              Platform.OS === 'android' ? styles.btnSq : styles.btn,
              Platform.OS === 'android' ? styles.btnOutline : null,
              Platform.OS === 'android' && pressed ? styles.btnPressed : null,
              Platform.OS !== 'android' && isRemoteMuted ? styles.btnDanger : null,
            ]}
          >
            <MaterialIcons
              name={isRemoteMuted ? 'volume-off' : 'volume-up'}
              size={18}
              color={Platform.OS === 'android' ? UI.fg : (isRemoteMuted ? UI.danger : UI.fg)}
            />
          </Pressable>

          {/* HANGUP */}
          <Pressable
            onPress={endCall}
            android_ripple={Platform.OS === 'android' ? { color: 'rgba(0,0,0,0.18)', radius: 20 } : undefined}
            style={({ pressed }) => [
              Platform.OS === 'android' ? styles.btnSq : styles.btn,
              Platform.OS === 'android' ? styles.btnSolidDanger : styles.end,
              Platform.OS === 'android' && pressed ? styles.btnSolidDangerPressed : null,
            ]}
          >
            <MaterialIcons name="call-end" size={16} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', zIndex: 9999, elevation: 9999 },
  hidden: { width: 0, height: 0, opacity: 0, position: 'absolute' },

  card: {
    flex: 1,
    borderRadius: 18,
    backgroundColor: UI.bg,
    borderWidth: 1,
    borderColor: UI.stroke,
    padding: 12,
    alignItems: 'stretch',
    justifyContent: 'space-between',
  },

  header: { alignItems: 'center' },
  avatarWrap: { width: 54, height: 54, marginBottom: 8, alignItems: 'center', justifyContent: 'center' },
  pulseRing: { position: 'absolute', width: 54, height: 54, borderRadius: 27, backgroundColor: UI.accentSoft },
  avatarImg: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, borderColor: UI.stroke },
  avatarFallback: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(113,91,168,0.22)', borderWidth: 1, borderColor: UI.stroke, alignItems: 'center', justifyContent: 'center',
  },
  name: { color: UI.fg, fontSize: 14, fontWeight: '600', textAlign: 'center', maxWidth: 120 },
  eqWrapper: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    marginBottom: 8,
    height: 10,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: UI.success, marginRight: 4 },
  status: { color: UI.subtle, fontSize: 11 },

  actions: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    marginTop: 10,
    gap: Platform.OS === 'android' ? 8 : 0,
  },
  btn: {
    flex: 1, height: 36, borderRadius: 10,
    borderWidth: 1,
    borderColor: UI.stroke,
    backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center', minWidth: 36, marginHorizontal: 3,
  },
  btnDanger: { 
    borderColor: 'rgba(255,77,79,0.45)', 
    backgroundColor: 'rgba(255,77,79,0.08)' 
  },
  end: { 
    backgroundColor: UI.danger, 
    borderColor: UI.danger 
  },
  // Квадрат с округлениями (Android-PiP)
  btnSq: {
    width: 35,
    height: 35,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  // Контуры
  btnOutline: {
    borderColor: 'rgba(255,255,255,0.16)',
  },
  btnOutlineDanger: {
    borderColor: UI.danger,
  },
  // Нажатие по контурным
  btnPressed: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  // Сплошная красная (отбой)
  btnSolidDanger: {
    backgroundColor: UI.danger,
    borderColor: UI.danger,
  },
  btnSolidDangerPressed: {
    backgroundColor: '#E64547',
    borderColor: '#E64547',
  },
});