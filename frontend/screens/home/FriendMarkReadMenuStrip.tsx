import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';
import {
  ANDROID_FRIEND_ACTION_HIT_SLOP,
  ANDROID_INSTANT_TOUCH,
  LIVI,
} from './constants';

const markReadStripStyles = StyleSheet.create({
  strip: {
    overflow: 'hidden',
    minWidth: 200,
    maxWidth: 320,
    alignSelf: 'flex-end',
    height: 35,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    backgroundColor: '#141518',
    justifyContent: 'center',
    zIndex: 1,
  },
  stripInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 15,
    paddingRight: 12,
    height: 32,
    width: '100%',
  },
  stripText: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    color: LIVI.white,
    fontSize: 12,
    fontWeight: '400',
    marginRight: 12,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 16,
  },
  btn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export function FriendMarkReadMenuStrip({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.96)).current;
  useEffect(() => {
    opacity.setValue(0);
    scale.setValue(0.96);
    const anim = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(scale, { toValue: 1, friction: 7, tension: 140, useNativeDriver: true }),
    ]);
    anim.start();
    return () => {
      anim.stop();
    };
  }, [opacity, scale]);
  return (
    <Animated.View
      style={[markReadStripStyles.strip, { opacity, transform: [{ scale }] }]}
      pointerEvents="auto"
      collapsable={false}
    >
      <View style={markReadStripStyles.stripInner} pointerEvents="box-none">
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={markReadStripStyles.stripText}
          allowFontScaling={false}
        >
          {label}
        </Text>
        <View style={markReadStripStyles.btnRow} pointerEvents="box-none">
          <TouchableOpacity
            style={markReadStripStyles.btn}
            activeOpacity={Platform.OS === 'android' ? 1 : 0.8}
            {...ANDROID_INSTANT_TOUCH}
            hitSlop={Platform.OS === 'android' ? ANDROID_FRIEND_ACTION_HIT_SLOP : undefined}
            onPress={onConfirm}
          >
            <Ionicons name="checkmark" size={17} color={LIVI.white} />
          </TouchableOpacity>
          <TouchableOpacity
            style={markReadStripStyles.btn}
            activeOpacity={Platform.OS === 'android' ? 1 : 0.8}
            {...ANDROID_INSTANT_TOUCH}
            hitSlop={Platform.OS === 'android' ? ANDROID_FRIEND_ACTION_HIT_SLOP : undefined}
            onPress={onCancel}
          >
            <MaterialIcons name="close" size={17} color={LIVI.text2} />
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}
