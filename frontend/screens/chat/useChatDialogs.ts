/** Notice + confirm dialog state for ChatScreen. */

import React from "react";

export type NoticeKind = "error" | "info";

export type OpenConfirmOpts = {
  title: string;
  message: string;
  okText: string;
  cancelText: string;
  destructive?: boolean;
  onConfirm: () => void;
};

export function useChatDialogs() {
  const [noticeVisible, setNoticeVisible] = React.useState(false);
  const [noticeTitle, setNoticeTitle] = React.useState("");
  const [noticeMessage, setNoticeMessage] = React.useState("");
  const [noticeKind, setNoticeKind] = React.useState<NoticeKind>("info");

  const [confirmVisible, setConfirmVisible] = React.useState(false);
  const [confirmTitle, setConfirmTitle] = React.useState("");
  const [confirmMessage, setConfirmMessage] = React.useState("");
  const [confirmCancelText, setConfirmCancelText] = React.useState("");
  const [confirmOkText, setConfirmOkText] = React.useState("");
  const [confirmDestructive, setConfirmDestructive] = React.useState(false);
  const onConfirmRef = React.useRef<(() => void) | null>(null);

  const closeNotice = React.useCallback(() => {
    setNoticeVisible(false);
  }, []);

  const showNotice = React.useCallback(
    (kind: NoticeKind, title: string, message: string) => {
      setNoticeKind(kind);
      setNoticeTitle(title);
      setNoticeMessage(message);
      setNoticeVisible(true);
    },
    [],
  );

  const openConfirm = React.useCallback((opts: OpenConfirmOpts) => {
    setConfirmTitle(opts.title);
    setConfirmMessage(opts.message);
    setConfirmOkText(opts.okText);
    setConfirmCancelText(opts.cancelText);
    setConfirmDestructive(!!opts.destructive);
    onConfirmRef.current = opts.onConfirm;
    setConfirmVisible(true);
  }, []);

  const closeConfirm = React.useCallback(() => {
    setConfirmVisible(false);
    onConfirmRef.current = null;
  }, []);

  const runConfirm = React.useCallback(() => {
    const fn = onConfirmRef.current;
    setConfirmVisible(false);
    onConfirmRef.current = null;
    try {
      fn?.();
    } catch {}
  }, []);

  return {
    noticeVisible,
    noticeTitle,
    noticeMessage,
    noticeKind,
    closeNotice,
    showNotice,
    confirmVisible,
    confirmTitle,
    confirmMessage,
    confirmCancelText,
    confirmOkText,
    confirmDestructive,
    openConfirm,
    closeConfirm,
    runConfirm,
  };
}
