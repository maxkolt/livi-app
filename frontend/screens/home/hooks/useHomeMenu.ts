import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Platform } from 'react-native';

export type HomeMenuTab = 'friends' | 'settings' | 'more';

export function useHomeMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<HomeMenuTab>('friends');
  const tabRef = useRef<HomeMenuTab>(tab);
  const menuOverlayOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Плавное появление оверлея меню — короткая анимация для быстрого отклика
  // КРИТИЧНО: при закрытии сбрасываем opacity в 0, чтобы при следующем открытии анимация была с 0
  useEffect(() => {
    if (!menuOpen) {
      menuOverlayOpacity.setValue(0);
      return;
    }
    menuOverlayOpacity.setValue(0);
    Animated.timing(menuOverlayOpacity, {
      toValue: 1,
      duration: 100,
      useNativeDriver: true,
    }).start();
  }, [menuOpen, menuOverlayOpacity]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    if (Platform.OS === 'android') {
      menuOverlayOpacity.setValue(0);
      return;
    }
    Animated.timing(menuOverlayOpacity, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [menuOverlayOpacity]);

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
    closeMenu,
  };
}
