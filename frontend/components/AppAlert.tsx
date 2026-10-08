/**
 * Сообщение об ошибке в виде модалок приложения — вместо системного Alert.alert,
 * у которого свой вид и своё затемнение. Хост один, в корне приложения.
 */

import React, { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { AppDialogModal } from './AppDialog';
import { t } from '../utils/i18n';
import { useLang } from '../store/lang';

type AppAlertRequest = { title: string; message?: string };

let showListener: ((request: AppAlertRequest) => void) | null = null;

export function showAppAlert(title: string, message?: string) {
  if (showListener) showListener({ title, message });
  // Хост ещё не смонтирован (самый ранний старт) — системный, лишь бы не потерять текст.
  else Alert.alert(title, message);
}

export function AppAlertHost() {
  const lang = useLang((s) => s.lang);
  const [request, setRequest] = useState<AppAlertRequest | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    showListener = (next) => {
      setRequest(next);
      setVisible(true);
    };
    return () => {
      showListener = null;
    };
  }, []);

  const close = () => setVisible(false);
  return (
    <AppDialogModal
      visible={visible}
      onRequestClose={close}
      title={request?.title}
      message={request?.message}
      actions={[{ label: t('ok', lang), onPress: close }]}
    />
  );
}
