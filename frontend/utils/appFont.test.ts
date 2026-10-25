import React from 'react';

const textRender = jest.fn((props: any, _ref?: any) => props);
const inputRender = jest.fn((props: any, _ref?: any) => props);

jest.mock('react-native', () => ({
  ...jest.requireActual('../__mocks__/react-native'),
  Text: { render: (props: any, ref: any) => textRender(props, ref) },
  TextInput: { render: (props: any, ref: any) => inputRender(props, ref) },
  PixelRatio: { getFontScale: () => 1 },
  Dimensions: { get: () => ({ width: 384, height: 850, scale: 1, fontScale: 1 }) },
}));
jest.mock('react-native/Libraries/Text/TextAncestor', () => ({ default: { _currentValue: false } }), {
  virtual: true,
});
jest.mock('@expo-google-fonts/exo-2/300Light', () => ({ Exo2_300Light: 1 }));
jest.mock('@expo-google-fonts/exo-2/400Regular', () => ({ Exo2_400Regular: 1 }));
jest.mock('@expo-google-fonts/exo-2/500Medium', () => ({ Exo2_500Medium: 1 }));
jest.mock('@expo-google-fonts/exo-2/600SemiBold', () => ({ Exo2_600SemiBold: 1 }));
jest.mock('@expo-google-fonts/exo-2/700Bold', () => ({ Exo2_700Bold: 1 }));

import { Text, TextInput } from 'react-native';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER, APP_TEXT_MAX_FONT_SIZE_MULTIPLIER } from './accessibilityTypography';
import { installAppFont } from './appFont';

const useContext = jest.spyOn(React, 'useContext');
const renderText = (props: any, nested = false) => {
  useContext.mockReturnValue(nested);
  (Text as any).render(props, null);
  return textRender.mock.calls[textRender.mock.calls.length - 1][0];
};
const renderInput = (props: any) => {
  (TextInput as any).render(props, null);
  return inputRender.mock.calls[inputRender.mock.calls.length - 1][0];
};

beforeAll(() => installAppFont());

describe('installAppFont font-size cap', () => {
  it('caps top-level Text at the app ceiling', () => {
    expect(renderText({ style: { fontFamily: 'Ionicons' } }).maxFontSizeMultiplier).toBe(
      APP_TEXT_MAX_FONT_SIZE_MULTIPLIER,
    );
  });

  it('keeps an explicit ceiling, including 0 (no cap)', () => {
    expect(renderText({ maxFontSizeMultiplier: 1.2 }).maxFontSizeMultiplier).toBe(1.2);
    expect(renderText({ maxFontSizeMultiplier: 0 }).maxFontSizeMultiplier).toBe(0);
  });

  it('lets nested Text inherit the parent ceiling', () => {
    expect(renderText({ style: { fontWeight: 'bold' } }, true).maxFontSizeMultiplier).toBeUndefined();
    expect(renderText({ style: {} }, true).maxFontSizeMultiplier).toBeUndefined();
  });

  it('caps TextInput at the input ceiling', () => {
    expect(renderInput({}).maxFontSizeMultiplier).toBe(APP_INPUT_MAX_FONT_SIZE_MULTIPLIER);
  });

  it('still swaps the system font for Exo 2', () => {
    const style = renderText({ style: { fontWeight: '600' } }).style;
    expect(style[style.length - 1]).toEqual({ fontFamily: 'Exo2_600SemiBold', fontWeight: 'normal' });
  });
});
