/** Delete-confirm modal state for ChatScreen. */

import React from "react";

export type DeleteConfirmKind = "single" | "multi";

export function useChatDeleteConfirm() {
  const [deleteConfirmVisible, setDeleteConfirmVisible] = React.useState(false);
  const [deleteForBoth, setDeleteForBoth] = React.useState(true);
  const [deleteConfirmKind, setDeleteConfirmKind] =
    React.useState<DeleteConfirmKind>("single");
  const pendingDeleteRef = React.useRef<any>(null);

  const closeDeleteConfirm = React.useCallback(() => {
    setDeleteConfirmVisible(false);
    setDeleteForBoth(true);
    setDeleteConfirmKind("single");
    pendingDeleteRef.current = null;
  }, []);

  const openDeleteConfirmSingle = React.useCallback((m: any) => {
    if (!m?.id) return;
    pendingDeleteRef.current = m;
    setDeleteConfirmKind("single");
    setDeleteForBoth(true);
    setDeleteConfirmVisible(true);
  }, []);

  const openDeleteConfirmMulti = React.useCallback((ids: string[]) => {
    pendingDeleteRef.current = { ids };
    setDeleteConfirmKind("multi");
    setDeleteForBoth(true);
    setDeleteConfirmVisible(true);
  }, []);

  /** Reset UI and return pending payload + forBoth choice. */
  const consumeDeleteConfirm = React.useCallback(() => {
    const m = pendingDeleteRef.current;
    const forBoth = deleteForBoth;
    setDeleteConfirmVisible(false);
    setDeleteForBoth(true);
    setDeleteConfirmKind("single");
    pendingDeleteRef.current = null;
    return { pending: m, forBoth };
  }, [deleteForBoth]);

  return {
    deleteConfirmVisible,
    deleteForBoth,
    setDeleteForBoth,
    deleteConfirmKind,
    pendingDeleteRef,
    closeDeleteConfirm,
    openDeleteConfirmSingle,
    openDeleteConfirmMulti,
    consumeDeleteConfirm,
  };
}
