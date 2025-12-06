import React from 'react';
import { View, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

interface MediaControlsProps {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onFlipCamera: () => void;
  localStream: any;
  visible: boolean;
  opacity: Animated.AnimatedValue;
}

/**
 * Общий компонент для управления медиа (микрофон, камера, переключение камеры)
 */
export const MediaControls: React.FC<MediaControlsProps> = ({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  onFlipCamera,
  localStream,
  visible,
  opacity,
}) => {
  if (!visible) return null;

  return (
    <>
      {/* Кнопка переключения камеры (слева вверху) */}
      <Animated.View style={[styles.topLeft, { opacity }]}>
        <TouchableOpacity
          onPress={onFlipCamera}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
          style={styles.iconBtn}
        >
          <MaterialIcons name="flip-camera-ios" size={26} color="#fff" />
        </TouchableOpacity>
      </Animated.View>

      {/* Кнопки микрофона и камеры (снизу) */}
      <Animated.View style={[styles.bottomOverlay, { opacity }]}>
        <TouchableOpacity
          onPress={onToggleMic}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
          style={styles.iconBtn}
        >
          <MaterialIcons
            name={micOn ? "mic" : "mic-off"}
            size={26}
            color={micOn ? "#fff" : "#888"}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onToggleCam}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
          style={styles.iconBtn}
          disabled={!localStream}
        >
          <MaterialIcons
            name={camOn ? "videocam" : "videocam-off"}
            size={26}
            color={camOn ? "#fff" : "#888"}
          />
        </TouchableOpacity>
      </Animated.View>
    </>
  );
};

const styles = StyleSheet.create({
  iconBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  topLeft: {
    position: 'absolute',
    top: 10,
    left: 10,
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});

