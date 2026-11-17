import React, { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppDialog } from './AppDialog';
import SplashLoader from './SplashLoader';
import { accountDataReset } from '../utils/accountDataResetRuntime';
import { useLang } from '../store/lang';
import { t } from '../utils/i18n';
import { WELCOME_STAGE_BG } from '../screens/home/constants';

export function AccountDataResetGate({ children }: { children: React.ReactNode }) {
  const status = useSyncExternalStore(accountDataReset.subscribe, accountDataReset.getStatus);
  const lang = useLang(s => s.lang);
  useEffect(() => { void accountDataReset.ensureReady(); }, []);
  if (status === 'ready') return <>{children}</>;
  if (status === 'checking' || status === 'resetting') return <SplashLoader hasContentReady={false} waitForContent />;
  const failed = status === 'failed';
  return (
    <View style={styles.root}>
      <AppDialog
        title={t(failed ? 'accountResetFailedTitle' : 'accountResetTitle', lang)}
        message={t(failed ? 'accountResetFailedMessage' : 'accountResetMessage', lang)}
        actions={[{
          label: t(failed ? 'accountResetRetry' : 'accountResetContinue', lang),
          onPress: () => { void (failed ? accountDataReset.retry() : accountDataReset.confirm()); },
          variant: 'primary',
        }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: WELCOME_STAGE_BG } });
