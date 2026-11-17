import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { NativeModules, Platform } from 'react-native';
import { API_BASE } from '../sockets/modules/constants';
import { fetchWithTimeout } from './fetchWithTimeout';
import { regenerateRandomInstallId } from './installId';
import { ACCOUNT_GENERATION_KEY, ACCOUNT_RESET_PENDING_KEY, ACCOUNT_FRESH_PROFILE_KEY, createAccountDataReset, hasSavedAccountData } from './accountDataReset';

const PRESERVED_KEYS = new Set(['app_lang', 'app_lang_mode', ACCOUNT_GENERATION_KEY, ACCOUNT_RESET_PENDING_KEY, ACCOUNT_FRESH_PROFILE_KEY]);

export const accountDataReset = createAccountDataReset({
  storage: AsyncStorage,
  async fetchGeneration() {
    try {
      const response = await fetchWithTimeout(`${API_BASE}/api/app-settings`, { headers: { 'Cache-Control': 'no-cache' } }, 5000);
      if (!response.ok) return null;
      const data = await response.json();
      const value = data?.accountDataGeneration;
      return data?.ok === true && typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
    } catch { return null; }
  },
  async hasLocalIdentity() {
    return hasSavedAccountData(AsyncStorage);
  },
  async resetLocalData() {
    // No AppContent or authenticated boot is allowed while this reset runs.
    const { getSocketInstance } = await import('../sockets/modules/socketCore');
    getSocketInstance()?.disconnect();
    const { clearPendingNotificationNavigationForAccountReset } = await import('./pushNotifications');
    await clearPendingNotificationNavigationForAccountReset();
    const userId = await AsyncStorage.getItem('userId');
    if (Platform.OS !== 'web' && userId) {
      const key = `livi.e2e.sk.${userId}`;
      await SecureStore.deleteItemAsync(key);
      await NativeModules.LiviKeyVault?.remove(key);
    }
    if (Platform.OS === 'android') {
      if (!NativeModules.LiviAppModule?.resetAccountDataForFreshStart) throw new Error('native_reset_unavailable');
      await NativeModules.LiviAppModule.resetAccountDataForFreshStart();
    }
    const { clearCosmeticsForAccountReset } = await import('./cosmetics');
    await clearCosmeticsForAccountReset();
    const { useMe } = await import('../store/me');
    useMe.getState().reset();
    const { useFriendRequests } = await import('../store/friendRequests');
    useFriendRequests.setState({ ownerId: null, items: [], busy: {} });
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter(key => !PRESERVED_KEYS.has(key)));
    // A fresh ID avoids reconnecting the stable ANDROID_ID to a retired account.
    await regenerateRandomInstallId();
    const { shared } = await import('../sockets/modules/shared');
    shared.currentUserId = undefined;
    shared.lastSuccessfulReauthAt = 0;
    shared.lastSuccessfulReauthSocketId = undefined;
    shared.lastSuccessfulReauthUserId = undefined;
    shared.userExistsCache.clear();
    shared.messageCache.clear();
    shared.pendingChecks.clear();
    shared.cancelledOutboxSendIds.clear();
    shared.cancelledOutboxDiskHydrated = false;
    shared.appliedFromReauthByUid.clear();
    shared.appliedFromPendingByUid.clear();
    const { __notifyCurrentUserId } = await import('../sockets/modules/authState');
    __notifyCurrentUserId();
  },
});
