/** Android: нижняя шторка вложений (камера / галерея). */

import React from "react";
import { Animated, Modal, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { t, type Lang } from "../../utils/i18n";
import { WELCOME_POPUP_PRESSED, WELCOME_POPUP_SHEET_CHROME } from "../home/constants";
import { GLASS_AVAILABLE, GlassFill } from "../home/WelcomeStageBackground";
import type { BackdropSources } from "../../components/BackdropBlur";

export type ChatAttachSheetHandle = { open: () => void };

type Props = {
  isDark: boolean;
  lang: Lang;
  LIVI: {
    bg: string;
    titan: string;
    white: string;
    accent: { vivid10: string; vivid12: string };
  };
  outlineColor?: string;
  bottomPad: number;
  /** Источники стекла чата: лист — стекло, сквозь него размыт чат. */
  backdrop?: BackdropSources | null;
  onCamera: () => void;
  onGallery: () => void;
};

/**
 * Видимость шторки — её собственное состояние: открытие перерисовывает только
 * её, а не весь ChatScreen (иначе кнопка вложений откликается с задержкой).
 */
export const ChatAttachSheet = React.forwardRef<ChatAttachSheetHandle, Props>(
  function ChatAttachSheet(
    { isDark, lang, LIVI, outlineColor, bottomPad, onCamera, onGallery, backdrop = null },
    ref,
  ) {
    const glass = isDark && GLASS_AVAILABLE;
    const [visible, setVisible] = React.useState(false);
    React.useImperativeHandle(ref, () => ({ open: () => setVisible(true) }), []);
    if (!visible) return null;
    const close = () => setVisible(false);

    return (
      <Modal
        transparent
        visible
        animationType="none"
        onRequestClose={close}
      >
        <Pressable
          onPress={close}
          style={{
            flex: 1,
            backgroundColor: isDark ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.40)',
            justifyContent: 'flex-end',
          }}
        >
          <Animated.View style={{ opacity: 1, transform: [{ translateY: 0 }] }}>
            <Pressable
              onPress={() => {}}
              style={{
                ...(glass
                  ? { backgroundColor: 'transparent' }
                  : isDark
                    ? WELCOME_POPUP_SHEET_CHROME
                    : { backgroundColor: LIVI.bg }),
                overflow: 'hidden',
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                paddingTop: 8,
                paddingBottom: bottomPad,
                paddingHorizontal: 14,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: -6 },
                shadowOpacity: 0.20,
                shadowRadius: 12,
                // Под полупрозрачным стеклом elevation рисует на Android белые прямоугольники.
                elevation: glass ? 0 : 12,
              }}
            >
              {glass ? (
                <GlassFill backdrop={backdrop} style={{ borderTopLeftRadius: 20, borderTopRightRadius: 20 }} />
              ) : null}
              <View style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 8 }}>
                <View
                  style={{
                    width: 42,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
                  }}
                />
              </View>

              <Pressable
                onPress={() => {
                  close();
                  onCamera();
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 14,
                  paddingHorizontal: 12,
                  borderRadius: 14,
                  overflow: 'hidden',
                  backgroundColor: pressed
                    ? (isDark ? WELCOME_POPUP_PRESSED : LIVI.accent.vivid10)
                    : 'transparent',
                })}
              >
                <Ionicons name="camera-outline" size={20} color={LIVI.titan} />
                <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                  {t('takePhoto', lang)}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  close();
                  onGallery();
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 14,
                  paddingHorizontal: 12,
                  borderRadius: 14,
                  overflow: 'hidden',
                  marginTop: 2,
                  backgroundColor: pressed
                    ? (isDark ? WELCOME_POPUP_PRESSED : LIVI.accent.vivid10)
                    : 'transparent',
                })}
              >
                <Ionicons name="images-outline" size={20} color={LIVI.titan} />
                <Text style={{ color: LIVI.white, fontSize: 16, fontWeight: '600', marginLeft: 12 }}>
                  {t('chooseFromGallery', lang)}
                </Text>
              </Pressable>

              <View style={{ height: 10 }} />

              <Pressable
                onPress={close}
                style={({ pressed }) => ({
                  paddingVertical: 14,
                  borderRadius: 14,
                  overflow: 'hidden',
                  backgroundColor: pressed
                    ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')
                    : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
                  ...(isDark
                    ? null
                    : {
                        borderWidth: 1,
                        borderColor: outlineColor || 'rgba(0,0,0,0.12)',
                      }),
                })}
              >
                <Text style={{ color: LIVI.titan, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                  {t('cancel', lang)}
                </Text>
              </Pressable>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    );
  },
);
