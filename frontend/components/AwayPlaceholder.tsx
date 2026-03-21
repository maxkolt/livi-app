// components/AwayPlaceholder.tsx
import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, StyleSheet, Image } from 'react-native';

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
      <Animated.View
        style={{
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
});

export default AwayPlaceholder;
