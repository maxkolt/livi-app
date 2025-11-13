import React from 'react';
import { View, Text, StyleSheet, Dimensions, Platform } from 'react-native';

type Props = {
  /** Подпись по центру (например: "Собеседник" или "Вы") */
  label?: string;
};

const { height } = Dimensions.get('window');

const LogoPlaceholder: React.FC<Props> = ({ label = 'Собеседник' }) => {
  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{label}</Text>
      </View>
      <Text style={styles.hint}>
        Ожидание подключения…
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: Platform.select({
    ios: {
      width: '95%',
      height: height * 0.4,
      backgroundColor: '#2a2a2a',
      borderRadius: 10,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
      marginVertical: 6,
      borderColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
    },
    android: {
      width: '95%',
      aspectRatio: 1,
      backgroundColor: '#2a2a2a',
      borderRadius: 10,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
      marginVertical: 6,
      borderColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
    },
    default: {
      width: '95%',
      aspectRatio: 1,
      backgroundColor: '#2a2a2a',
      borderRadius: 10,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
      marginVertical: 6,
      borderColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
    },
  }) as any,

  badge: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 999,
  },
  badgeText: {
    color: 'rgba(237, 234, 234, 0.9)',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  hint: {
    marginTop: 10,
    color: 'rgba(237, 234, 234, 0.6)',
    fontSize: 13,
  },
});

export default LogoPlaceholder;
