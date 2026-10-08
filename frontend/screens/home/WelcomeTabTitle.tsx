import React from 'react';
import { StyleSheet, View } from 'react-native';
import AdaptiveText from '../../components/AdaptiveText';
import { useNickDigitalFont } from './brandFont';
import { WELCOME_HEADER_TITLE } from './constants';

type WelcomeTabTitleProps = {
  label: string;
  tablet?: boolean;
  /** Низкий landscape телефона — отступы шапки там меньше. */
  compact?: boolean;
  /** Отступ текста от краёв, если кнопок у края больше одной. */
  sideInset?: number;
};

/**
 * Название вкладки посередине шапки «Друзья / Звонки / Чат» — между кнопкой поиска
 * и короной. Тот же «цифровой» шрифт, что у ника над радаром на «Поиске».
 * Лежит поверх шапки во всю ширину и не мешает касаниям: по центру экрана, а не
 * между кнопками (слева у шапки отступ больше), и по вертикали — вровень с кнопками.
 */
export function WelcomeTabTitle({ label, tablet, compact, sideInset }: WelcomeTabTitleProps) {
  const font = useNickDigitalFont();
  // Те же вертикальные отступы, что у styles.header во вкладках.
  const paddingTop = compact ? 2 : tablet ? 8 : 2;
  const paddingBottom = compact ? 2 : tablet ? 10 : 4;
  const fontSize = compact ? 17 : tablet ? 24 : 19;
  return (
    <View
      pointerEvents="none"
      style={[styles.wrap, { paddingTop, paddingBottom }, sideInset != null && { paddingHorizontal: sideInset }]}
    >
      <AdaptiveText
        style={[
          styles.title,
          {
            fontFamily: font.fontFamily,
            fontWeight: font.fontWeight,
            fontSize,
            lineHeight: Math.round(fontSize * 1.25),
          },
        ]}
        numberOfLines={1}
      >
        {label}
      </AdaptiveText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    // Не наезжать на кнопки поиска и короны по краям.
    paddingHorizontal: 72,
  },
  title: {
    color: WELCOME_HEADER_TITLE,
    letterSpacing: 1,
    textAlign: 'center',
  },
});
