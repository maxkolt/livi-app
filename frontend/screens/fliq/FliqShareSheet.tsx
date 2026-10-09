// «Переслать» из Fliq: тот же экран выбора друзей, что у «Поделиться» из других приложений.
// Ролик уходит обычным текстом-ссылкой: шифрование чата и старые версии приложения работают
// как с любой ссылкой, а новые показывают её карточкой с плеером.
import React, { useEffect, useMemo, useState } from 'react';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { SharePickerContent } from '../../components/IncomingSharePickerModal';
import type { IncomingShareItem } from '../../utils/incomingShare';

export function FliqShareSheet({ url, onClose }: { url: string | null; onClose: () => void }) {
  // Ссылку держим и во время затухания, чтобы экран не пустел на глазах.
  const [lastUrl, setLastUrl] = useState(url);
  useEffect(() => {
    if (url) setLastUrl(url);
  }, [url]);
  const items = useMemo<IncomingShareItem[]>(
    () => (lastUrl ? [{ kind: 'text', text: lastUrl }] : []),
    [lastUrl],
  );
  return (
    <FullScreenPortal visible={!!url} onRequestClose={onClose}>
      <SharePickerContent visible={!!url} items={items} onClose={onClose} />
    </FullScreenPortal>
  );
}
