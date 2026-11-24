const mockPlatform = { OS: 'android' };
const mockDevice = { modelName: 'SM-A356E' };
const mockDensity = { value: 2.625 };
jest.mock('react-native', () => ({
  Platform: mockPlatform,
  NativeModules: {},
  PixelRatio: { get: () => mockDensity.value },
  StyleSheet: { hairlineWidth: 0.5 },
}));
jest.mock('expo-device', () => mockDevice);
import { welcomeTabBarBottomGap, welcomeTabBarContentHeight, welcomeTabBarMetrics, welcomeTabBarDockGap } from './welcomeTabBarLayout';

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockDevice.modelName = 'SM-A356E';
  mockDensity.value = 2.625;
});
it.each([0, 8, 16, 24])('matches the button-navigation clearance for gesture inset %s', inset => {
  expect(welcomeTabBarBottomGap(inset, false, false)).toBe(56);
  expect(welcomeTabBarDockGap(inset, 56)).toBe(inset + 28);
});
it('preserves the established gap above a full Android button bar', () => {
  expect(welcomeTabBarBottomGap(48, false, false)).toBe(56);
  expect(welcomeTabBarDockGap(48, 56)).toBe(48);
});
it('leaves the compact landscape dock at its established height', () => {
  expect(welcomeTabBarBottomGap(0, false, true)).toBe(10);
});
it('adds the same gesture clearance on tablets', () => {
  expect(welcomeTabBarBottomGap(16, true, false)).toBe(56);
});
it('preserves the iOS home-indicator spacing', () => {
  mockPlatform.OS = 'ios';
  expect(welcomeTabBarBottomGap(34, false, false)).toBe(42);
  expect(welcomeTabBarDockGap(34, 42)).toBe(42);
  expect(welcomeTabBarBottomGap(0, false, false)).toBe(10);
});
it('keeps the dock content height independent of navigation mode', () => {
  expect(welcomeTabBarContentHeight(false, false)).toBe(66.5);
  expect(welcomeTabBarContentHeight(false, true)).toBe(50.5);
  expect(welcomeTabBarContentHeight(true, false)).toBe(76);
});

it.each([
  [411.43, 891.43, 2.625],
  [384, 832, 2.8125],
  [432, 936, 2.5],
])('matches the Online panel and raises A35 chrome at %s x %s dp', (width, height, density) => {
  mockDensity.value = density;
  expect(welcomeTabBarMetrics(width, height, 16)).toEqual({
    smallPhonePortrait: true, contentHeight: 78, bottomGap: 64, ctaLift: 8,
  });
});
it('keeps the extra A35 lift with either gesture navigation or system buttons', () => {
  expect(welcomeTabBarMetrics(411, 891, 0).bottomGap).toBe(64);
  expect(welcomeTabBarMetrics(411, 891, 48).bottomGap).toBe(64);
});
it('matches the compact Online panel on smaller, short screens', () => {
  mockDevice.modelName = 'smaller-phone';
  mockDensity.value = 2;
  expect(welcomeTabBarMetrics(320, 568, 0)).toEqual({
    smallPhonePortrait: true, contentHeight: 66, bottomGap: 64, ctaLift: 8,
  });
});
it.each([[360, 780, 4], [384, 832, 2.8125], [411, 891, 3.5]])(
  'preserves S25 Ultra geometry despite display zoom at %s x %s dp', (width, height, density) => {
    mockDevice.modelName = 'SM-S938B';
    mockDensity.value = density;
    expect(welcomeTabBarMetrics(width, height, 48)).toEqual({
      smallPhonePortrait: false, contentHeight: 66.5, bottomGap: 56, ctaLift: 0,
    });
  },
);
it('preserves tablet and landscape geometry', () => {
  expect(welcomeTabBarMetrics(800, 1200, 16)).toEqual({
    smallPhonePortrait: false, contentHeight: 76, bottomGap: 56, ctaLift: 0,
  });
  expect(welcomeTabBarMetrics(891, 411, 0)).toEqual({
    smallPhonePortrait: false, contentHeight: 50.5, bottomGap: 10, ctaLift: 0,
  });
});
