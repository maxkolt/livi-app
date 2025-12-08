import React, { useCallback, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { useAppTheme } from '../../../theme/ThemeProvider';
import { t, type Lang } from '../../../utils/i18n';
import { logger } from '../../../utils/logger';

interface IncomingCallModalProps {
  visible: boolean;
  incomingFriendCall: { from: string; nick?: string } | null;
  incomingCall: { callId: string; from: string; fromNick?: string } | null;
  lang: Lang;
  isDark: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onRequestClose: () => void;
}

/**
 * Компонент модального окна входящего звонка
 * Обрабатывает волнушки, анимации, кнопки accept/decline, управление accept-состоянием
 */
export const IncomingCallModal: React.FC<IncomingCallModalProps> = ({
  visible,
  incomingFriendCall,
  incomingCall,
  lang,
  isDark,
  onAccept,
  onDecline,
  onRequestClose,
}) => {
  const L = (key: string) => t(key, lang);

  // Анимация входящего звонка
  const callShake = useRef(new Animated.Value(0)).current;
  const waveA = useRef(new Animated.Value(0)).current;
  const waveB = useRef(new Animated.Value(0)).current;

  const callIconStyle = {
    transform: [
      {
        translateX: callShake.interpolate({ inputRange: [0, 1, 2, 3, 4], outputRange: [0, -6, 6, -3, 0] })
      }
    ]
  };

  const waveS = (val: Animated.Value, dir: 'left' | 'right') => ({
    position: 'absolute' as const,
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
    transform: [
      { scale: val.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.35] }) },
      { translateX: dir === 'left' ? -30 : 30 },
    ],
  });

  const startIncomingAnim = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(callShake, { toValue: 1, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 2, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 3, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 4, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 0, duration: 80, useNativeDriver: true }),
        Animated.delay(300),
      ])
    ).start();

    const loop = (v: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 1400, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ).start();
    };
    loop(waveA, 0);
    loop(waveB, 400);
  }, [callShake, waveA, waveB]);

  const stopIncomingAnim = useCallback(() => {
    callShake.stopAnimation();
    waveA.stopAnimation();
    waveB.stopAnimation();
  }, [callShake, waveA, waveB]);

  // Запускаем/останавливаем анимацию при изменении visible
  useEffect(() => {
    if (visible) {
      startIncomingAnim();
    } else {
      stopIncomingAnim();
    }
    return () => {
      stopIncomingAnim();
    };
  }, [visible, startIncomingAnim, stopIncomingAnim]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose}
    >
      <View style={styles.modalOverlay}>
        <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
        <View style={styles.modalCard}>
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View style={waveS(waveA, 'left')} />
              <Animated.View style={waveS(waveB, 'right')} />
              <Animated.View style={callIconStyle}>
                <MaterialIcons name="call" size={48} color="#4FC3F7" />
              </Animated.View>
            </View>
            <Text style={styles.incomingTitle}>Входящий вызов</Text>
            <Text style={styles.incomingName}>
              {incomingFriendCall?.nick || `id: ${String(incomingFriendCall?.from || '').slice(0, 5)}`}
            </Text>
            <View style={styles.incomingButtons}>
              <TouchableOpacity
                onPress={onAccept}
                style={[styles.btnGlassBase, styles.btnGlassSuccess]}
              >
                <Text style={styles.modalBtnText}>Принять</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDecline}
                style={[styles.btnGlassBase, styles.btnGlassDanger]}
              >
                <Text style={styles.modalBtnText}>Отклонить</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: '86%',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
  },
  incomingTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 10,
  },
  incomingName: {
    color: '#e5e7eb',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
    marginBottom: 14,
  },
  incomingButtons: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    paddingHorizontal: 28,
    justifyContent: 'center',
  },
  btnGlassBase: {
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    flex: 1,
  },
  btnGlassSuccess: {
    backgroundColor: 'rgba(76, 175, 80, 0.16)',
    borderColor: 'rgba(76, 175, 80, 0.65)',
  },
  btnGlassDanger: {
    backgroundColor: 'rgba(255,77,77,0.16)',
    borderColor: 'rgba(255,77,77,0.65)',
  },
  modalBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});
