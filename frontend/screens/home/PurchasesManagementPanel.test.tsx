import React from 'react';
import { Alert } from 'react-native';
let mockState: unknown[] = [];
let mockCursor = 0;
const mockBusyRef = { current: false };
const mockSetActive = jest.fn();
const mockDelete = jest.fn();
const mockCosmetics = {
  purchasedFrameIds: ['fire'], purchasedBackgroundIds: ['aurora-chat'],
  activeFrameId: 'fire', activeBackgroundId: 'aurora-chat',
};
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const i = mockCursor++;
    if (!(i in mockState)) mockState[i] = initial;
    return [mockState[i], (value: unknown) => { mockState[i] = value; }];
  },
  useRef: () => mockBusyRef,
}));
jest.mock('react-native', () => ({
  View: 'View', Pressable: 'Pressable', Alert: { alert: jest.fn() },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
}));
jest.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
jest.mock('../../components/AppDialog', () => ({ AppDialogModal: 'AppDialogModal' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('../../components/AdaptiveText', () => ({ __esModule: true, default: 'AdaptiveText' }));
jest.mock('../../components/frames/CosmeticFramePreview', () => ({ CosmeticFramePreview: 'CosmeticFramePreview' }));
jest.mock('../../utils/cosmetics', () => ({
  useCosmetics: () => mockCosmetics,
  setActiveCosmetic: (...args: unknown[]) => mockSetActive(...args),
  deleteOwnedCosmetic: (...args: unknown[]) => mockDelete(...args),
  cosmeticNameKey: (id: string) => id,
}));
jest.mock('../../utils/cosmeticCatalog', () => ({ getCosmeticBackground: () => null }));
jest.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
jest.mock('../../store/lang', () => ({ useLang: () => 'ru' }));
jest.mock('./constants', () => ({ LIVI: { text: '#fff' } }));
import { PurchasesManagementPanel } from './PurchasesManagementPanel';

type Button = React.ReactElement<{ onPress: () => void; disabled: boolean; accessibilityLabel: string }>;
function buttons(includeDelete = false): Button[] {
  const found: Button[] = [];
  function walk(node: React.ReactNode) {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return;
      if ((child.type as unknown) === 'Pressable') found.push(child as Button);
      walk(child.props.children);
    });
  }
  mockCursor = 0; walk(PurchasesManagementPanel());
  return includeDelete ? found : found.filter(button => !button.props.accessibilityLabel.endsWith('purchasesDelete'));
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  mockState = []; mockCursor = 0; mockBusyRef.current = false;
  mockSetActive.mockReset(); mockDelete.mockReset(); jest.mocked(Alert.alert).mockClear();
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


type DialogProps = { visible: boolean; message: string; onRequestClose: () => void; actions: Array<{ onPress: () => void; busy?: boolean; disabled?: boolean }> };
function dialog(): React.ReactElement<DialogProps> {
  mockCursor = 0;
  const root = PurchasesManagementPanel();
  return React.Children.toArray(root.props.children).find(child => React.isValidElement(child) && (child.type as unknown) === 'AppDialogModal') as React.ReactElement<DialogProps>;
}
it('requires confirmation before deleting ownership and makes cancellation harmless', () => {
  const remove = buttons(true).find(button => button.props.accessibilityLabel === 'fire: purchasesDelete')!;
  remove.props.onPress();
  expect(mockDelete).not.toHaveBeenCalled();
  expect(dialog().props.visible).toBe(true);
  dialog().props.actions[0].onPress();
  expect(dialog().props.visible).toBe(false);
  expect(mockDelete).not.toHaveBeenCalled();
});
it('submits full deletion once and closes the dialog after success', async () => {
  let finish!: () => void;
  mockDelete.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  buttons(true).find(button => button.props.accessibilityLabel === 'aurora-chat: purchasesDelete')!.props.onPress();
  const confirm = dialog().props.actions[1];
  confirm.onPress(); confirm.onPress();
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledWith('background', 'aurora-chat');
  expect(dialog().props.actions[1].busy).toBe(true);
  dialog().props.onRequestClose();
  expect(dialog().props.visible).toBe(true);
  finish(); await flush();
  expect(dialog().props.visible).toBe(false);
});
it('keeps the deletion dialog retryable after a network failure', async () => {
  mockDelete.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  buttons(true).find(button => button.props.accessibilityLabel === 'fire: purchasesDelete')!.props.onPress();
  dialog().props.actions[1].onPress(); await flush();
  expect(dialog().props.visible).toBe(true);
  expect(dialog().props.message).toBe('purchasesDeleteError');
  expect(dialog().props.actions[1].busy).toBe(false);
  dialog().props.actions[1].onPress(); await flush();
  expect(mockDelete).toHaveBeenCalledTimes(2);
  expect(dialog().props.visible).toBe(false);
});
