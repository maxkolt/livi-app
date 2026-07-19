/** Album multi-select modal state (save / forward / delete scope). */

import React from "react";
import {
  albumPickInitialIndices,
  type AlbumScopeKind,
} from "./chatAlbumActions";
import { getMessageImageUris } from "./chatAlbum";

export function useChatAlbumScope() {
  const [albumScopeVisible, setAlbumScopeVisible] = React.useState(false);
  const [albumScopeKind, setAlbumScopeKind] = React.useState<AlbumScopeKind>("delete");
  const [albumPickUris, setAlbumPickUris] = React.useState<string[]>([]);
  const [albumPickInitial, setAlbumPickInitial] = React.useState<number[]>([0]);
  const albumScopeMessageRef = React.useRef<any>(null);

  const closeAlbumScope = React.useCallback(() => {
    setAlbumScopeVisible(false);
    albumScopeMessageRef.current = null;
    setAlbumPickUris([]);
    setAlbumPickInitial([0]);
  }, []);

  const openAlbumScope = React.useCallback(
    (kind: AlbumScopeKind, m: any, focusIndex: number | null) => {
      const uris = getMessageImageUris(m);
      albumScopeMessageRef.current = m;
      setAlbumScopeKind(kind);
      setAlbumPickUris(uris);
      setAlbumPickInitial(albumPickInitialIndices(uris, focusIndex));
      setAlbumScopeVisible(true);
    },
    [],
  );

  /** Reset pick UI after confirming (caller still reads messageRef before this). */
  const consumeAlbumScope = React.useCallback(() => {
    const m = albumScopeMessageRef.current;
    const kind = albumScopeKind;
    setAlbumScopeVisible(false);
    albumScopeMessageRef.current = null;
    setAlbumPickUris([]);
    return { message: m, kind };
  }, [albumScopeKind]);

  return {
    albumScopeVisible,
    setAlbumScopeVisible,
    albumScopeKind,
    setAlbumScopeKind,
    albumPickUris,
    setAlbumPickUris,
    albumPickInitial,
    setAlbumPickInitial,
    albumScopeMessageRef,
    closeAlbumScope,
    openAlbumScope,
    consumeAlbumScope,
  };
}
