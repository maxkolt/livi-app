import React from 'react';
import { Alert } from 'react-native';
let mockBusyKey = '';
const mockBusyRef = { current: false };
const mockSetActive = jest.fn();
const mockCosmetics = {
  purchasedFrameIds: ['fire'], purchasedBackgroundIds: ['aurora-chat'],
  activeFrameId: 'fire', activeBackgroundId: 'aurora-chat',
};
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: () => [mockBusyKey, (value: string) => { mockBusyKey = value; }],
  useRef: () => mockBusyRef,
}));
jest.mock('react-native', () => ({
  View: 'View', Pressable: 'Pressable', Alert: { alert: jest.fn() },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
}));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('../../components/AdaptiveText', () => ({ __esModule: true, default: 'AdaptiveText' }));
jest.mock('../../components/frames/CosmeticFramePreview', () => ({ CosmeticFramePreview: 'CosmeticFramePreview' }));
jest.mock('../../utils/cosmetics', () => ({
  useCosmetics: () => mockCosmetics,
  setActiveCosmetic: (...args: unknown[]) => mockSetActive(...args),
  cosmeticNameKey: (id: string) => id,
}));
jest.mock('../../utils/cosmeticCatalog', () => ({ getCosmeticBackground: () => null }));
jest.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
jest.mock('../../store/lang', () => ({ useLang: () => 'ru' }));
jest.mock('./constants', () => ({ LIVI: { text: '#fff' } }));
import { PurchasesManagementPanel } from './PurchasesManagementPanel';

type Button = React.ReactElement<{ onPress: () => void; disabled: boolean; accessibilityLabel: string }>;
function buttons(): Button[] {
  const found: Button[] = [];
  function walk(node: React.ReactNode) {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return;
      if ((child.type as unknown) === 'Pressable') found.push(child as Button);
      walk(child.props.children);
    });
  }
  walk(PurchasesManagementPanel());
  return found;
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  mockBusyKey = ''; mockBusyRef.current = false;
  mockSetActive.mockReset(); jest.mocked(Alert.alert).mockClear();
});
it.each([['frame', 0], ['background', 1]] as const)('removes the active %s once even on repeated taps before React rerenders', async (kind, index) => {
  let finish!: () => void;
  mockSetActive.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const button = buttons()[index];
  button.props.onPress(); button.props.onPress();
  expect(mockSetActive).toHaveBeenCalledTimes(1);
  expect(mockSetActive).toHaveBeenCalledWith(kind, '');
  expect(buttons().every(candidate => candidate.props.disabled)).toBe(true);
  finish(); await flush();
  expect(buttons().every(candidate => !candidate.props.disabled)).toBe(true);
});
it('shows a failed change and releases both buttons so the user can retry', async () => {
  mockSetActive.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce(undefined);
  buttons()[0].props.onPress(); await flush();
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'storePaymentOpenFailedText');
  expect(buttons().every(button => !button.props.disabled)).toBe(true);
  buttons()[0].props.onPress(); await flush();
  expect(mockSetActive).toHaveBeenCalledTimes(2);
  expect(Alert.alert).toHaveBeenCalledTimes(1);
});
it('identifies a persistent authorization refusal instead of blaming connectivity', async () => {
  mockSetActive.mockRejectedValue(new Error('unauthorized'));
  buttons()[0].props.onPress(); await flush();
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'unauthorizedError');
  expect(buttons().every(button => !button.props.disabled)).toBe(true);
});
