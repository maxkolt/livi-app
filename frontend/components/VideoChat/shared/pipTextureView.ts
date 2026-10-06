import { Platform } from 'react-native';
import { NativeBlurBackdrop } from '../../BackdropBlur';

/**
 * Маленькие окна видео (свой кадр на экране звонка, в in-app и системном PiP) рисуем в TextureView
 * (патч react-native-webrtc, проп `textureView`): только его обрезает скругление родителя.
 * SurfaceView система композит мимо окна — у него углы прямые или скруглены частично.
 * Android 12+ — там же, где нативное стекло; на старых Android окна остаются прямыми.
 */
export const PIP_TEXTURE_VIEW = Platform.OS === 'android' && !!NativeBlurBackdrop;

/** Скругление без рамки: iOS обрезает RTCView сам, Android — только TextureView. */
export const PIP_ROUNDED = Platform.OS === 'ios' || PIP_TEXTURE_VIEW;
