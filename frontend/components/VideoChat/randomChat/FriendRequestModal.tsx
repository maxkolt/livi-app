import React from 'react';
import { t } from '../../../utils/i18n';
import type { Lang } from '../../../utils/i18n';
import { AppDialogModal } from '../../AppDialog';

type Props = {
  visible: boolean;
  lang: Lang;
  friendRequestDisplayName: string;
  L: (key: string) => string;
  onRequestClose: () => void;
  onDecline: () => void;
  onAccept: () => void;
};

export function FriendRequestModal({
  visible,
  lang,
  friendRequestDisplayName,
  L,
  onRequestClose,
  onDecline,
  onAccept,
}: Props) {
  return (
    <AppDialogModal
      visible={visible}
      onRequestClose={onRequestClose}
      title={L('friend_request')}
      message={t('friend_request_text', lang).replace('{user}', friendRequestDisplayName)}
      actions={[
        { label: L('decline'), onPress: onDecline },
        { label: L('accept'), onPress: onAccept, variant: 'primary' },
      ]}
    />
  );
}
