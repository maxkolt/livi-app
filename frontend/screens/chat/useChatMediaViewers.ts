import type { PickedChatImage } from './chatMessageTypes';
/** Media viewer + compose preview visibility. */

import React from "react";

type ChatSelectedMedia = {
  type: "image";
  uri: string;
  name?: string;
  uris?: string[];
  index?: number;
};

export function useChatMediaViewers() {
  const [mediaViewerVisible, setMediaViewerVisibleState] = React.useState(false);
  const mediaViewerVisibleRef = React.useRef(false);
  const setMediaViewerVisible = React.useCallback((next: React.SetStateAction<boolean>) => {
    const visible = typeof next === 'function' ? next(mediaViewerVisibleRef.current) : next;
    mediaViewerVisibleRef.current = visible;
    setMediaViewerVisibleState(visible);
  }, []);
  const [selectedMedia, setSelectedMedia] = React.useState<ChatSelectedMedia | null>(null);
  const [composeViewerVisible, setComposeViewerVisibleState] = React.useState(false);
  const composeViewerVisibleRef = React.useRef(false);
  const setComposeViewerVisible = React.useCallback((next: React.SetStateAction<boolean>) => {
    const visible = typeof next === 'function' ? next(composeViewerVisibleRef.current) : next;
    composeViewerVisibleRef.current = visible;
    setComposeViewerVisibleState(visible);
  }, []);
  const [composeAssets, setComposeAssets] = React.useState<PickedChatImage[]>([]);
  const composeAsset = composeAssets[0] || null;

  const openMediaViewer = React.useCallback((media: ChatSelectedMedia) => {
    setSelectedMedia(media);
    setMediaViewerVisible(true);
  }, []);

  const closeMediaViewer = React.useCallback(() => {
    setMediaViewerVisible(false);
  }, []);

  const finishMediaViewerClose = React.useCallback(() => {
    // A delayed hide from a previous opening cannot clear a newly opened photo.
    if (!mediaViewerVisibleRef.current) setSelectedMedia(null);
  }, []);

  const finishComposeViewerClose = React.useCallback(() => {
    if (!composeViewerVisibleRef.current) setComposeAssets([]);
  }, []);

  const openComposeViewer = React.useCallback((asset: PickedChatImage | PickedChatImage[]) => {
    setComposeAssets(Array.isArray(asset) ? asset : [asset]);
    setComposeViewerVisible(true);
  }, []);

  const closeComposeViewer = React.useCallback(() => {
    setComposeViewerVisible(false);
  }, []);

  return {
    mediaViewerVisible,
    setMediaViewerVisible,
    selectedMedia,
    setSelectedMedia,
    openMediaViewer,
    closeMediaViewer,
    finishMediaViewerClose,
    composeViewerVisible,
    setComposeViewerVisible,
    composeAsset,
    composeAssets,
    setComposeAssets,
    openComposeViewer,
    closeComposeViewer,
    finishComposeViewerClose,
  };
}
