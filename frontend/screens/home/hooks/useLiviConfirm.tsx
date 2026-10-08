import React, { useCallback, useState } from 'react';
import { t } from '../../../utils/i18n';
import { useLang } from '../../../store/lang';
import { AppDialogModal } from '../../../components/AppDialog';

/** Подтверждение удаления на главной — в общем виде диалогов приложения. */
export function useLiviConfirm() {
  const [state, setState] = useState<{
    visible: boolean;
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    resolve?: (v: boolean) => void;
  }>({ visible: false, title: '' });
  const lang = useLang((s) => s.lang);

  const ask = useCallback((opts: { title: string; message?: string; confirmText?: string; cancelText?: string }) =>
    new Promise<boolean>((resolve) => {
      setState({
        visible: true,
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText || t('ok', lang),
        cancelText: opts.cancelText || t('cancel', lang),
        resolve,
      });
    }), [lang]);
  const onCancel = useCallback(() => { state.resolve?.(false); setState((s) => ({ ...s, visible: false })); }, [state]);
  const onOk = useCallback(() => { state.resolve?.(true); setState((s) => ({ ...s, visible: false })); }, [state]);

  // Всегда в дереве: закрытие доигрывает исчезновение с тем же текстом.
  const view = (
    <AppDialogModal
      visible={state.visible}
      onRequestClose={onCancel}
      title={state.title}
      message={state.message}
      actions={[
        { label: state.cancelText || t('cancel', lang), onPress: onCancel },
        { label: state.confirmText || t('ok', lang), onPress: onOk, variant: 'danger' },
      ]}
    />
  );

  return { askConfirm: ask, ConfirmView: view };
}
