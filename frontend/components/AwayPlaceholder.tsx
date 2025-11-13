// components/AwayPlaceholder.tsx
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet, Image } from 'react-native';

const AwayPlaceholder = () => {
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const floatAnim = useRef(new Animated.Value(0)).current;

  // бесконечное плавное вращение (3D безопасно для iOS)
  useEffect(() => {
    const spinLoop = () => {
      rotateAnim.setValue(0);
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 12000,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(() => spinLoop());
    };
    spinLoop();
  }, [rotateAnim]);

  // плавное подпрыгивание
  useEffect(() => {
    const floatLoop = () => {
      floatAnim.setValue(0);
      Animated.timing(floatAnim, {
        toValue: 1,
        duration: 4000,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(() => floatLoop());
    };
    floatLoop();
  }, [floatAnim]);

  const floatY = floatAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [-6, 6, -6],
  });

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.container}>
      {/* Логотип */}
      <Animated.View
        style={{
          // 3D без артефактов: выключаем сглаживание обратной стороны и слегка уменьшаем перспективу
          backfaceVisibility: 'visible',
          transform: [
            { perspective: 600 },
            { rotateY: spin },
            { translateY: floatY },
          ],
        }}
      >
        <Image source={require('../assets/favicon.png')} style={styles.logo} />
      </Animated.View>

      {/* Надпись + анимированные точки */}
      <View style={styles.textRow}>
        <Text style={styles.awayText}>Отошёл</Text>
        <AnimatedDots />
      </View>
    </View>
  );
};

// Компонент для анимированных точек
const AnimatedDots = () => {
  const opacities = [
    useRef(new Animated.Value(0.2)).current,
    useRef(new Animated.Value(0.2)).current,
    useRef(new Animated.Value(0.2)).current,
  ];

  useEffect(() => {
    opacities.forEach((opacity, i) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 300),
          Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.2, duration: 400, useNativeDriver: true }),
        ])
      ).start();
    });
  }, []);

  return (
    <View style={{ flexDirection: 'row' }}>
      {opacities.map((opacity, i) => (
        <Animated.Text key={i} style={[styles.awayText, { opacity }]}>
          .
        </Animated.Text>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 90,
    height: 90,
    resizeMode: 'contain',
    borderRadius: 16,
  },
  textRow: {
    flexDirection: 'row',
    marginTop: 12,
    alignItems: 'center',
  },
  awayText: {
    fontSize: 16,
    color: 'rgba(229, 226, 226, 0.85)',
    fontWeight: '400',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});

export default AwayPlaceholder;
