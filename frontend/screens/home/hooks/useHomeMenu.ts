import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Platform } from 'react-native';

export type HomeMenuTab = 'friends' | 'settings' | 'more';

/** Увод закрытого меню за экран — иначе вкладки «торчат» в app-switcher при opacity:0. */
const MENU_OFFSCREEN_Y = 10000;

export function useHomeMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<HomeMenuTab>('friends');
  const tabRef = useRef<HomeMenuTab>(tab);
  const menuOverlayOpacity = useRef(new Animated.Value(0)).current;
  const menuOverlayTranslateY = useRef(new Animated.Value(MENU_OFFSCREEN_Y)).current;

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Оверлей остаётся смонтированным: show/hide через opacity + translateY.
  // Не сбрасываем menuOpen/tab при уходе в фон — возврат на ту же вкладку.
  useEffect(() => {
    if (!menuOpen) {
      menuOverlayOpacity.setValue(0);
      menuOverlayTranslateY.setValue(MENU_OFFSCREEN_Y);
      return;
    }
    menuOverlayTranslateY.setValue(0);
    // Android: мгновенный показ — без fade, иначе первый open ощущается «ватным».
    if (Platform.OS === 'android') {
      menuOverlayOpacity.setValue(1);
      return;
    }
    menuOverlayOpacity.setValue(0);
    Animated.timing(menuOverlayOpacity, {
      toValue: 1,
      duration: 100,
      useNativeDriver: true,
    }).start();
  }, [menuOpen, menuOverlayOpacity, menuOverlayTranslateY]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuOverlayOpacity.setValue(0);
    menuOverlayTranslateY.setValue(MENU_OFFSCREEN_Y);
  }, [menuOverlayOpacity, menuOverlayTranslateY]);

  // На Android: при открытом меню кнопка "Назад" закрывает меню (возврат на страницу приветствия)
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!menuOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeMenu();
      return true;
    });
    return () => sub.remove();
  }, [menuOpen, closeMenu]);

  return {
    menuOpen,
    setMenuOpen,
    tab,
    setTab,
    tabRef,
    menuOverlayOpacity,
    menuOverlayTranslateY,
    closeMenu,
  };
}
