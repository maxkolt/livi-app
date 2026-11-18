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
  const [mediaViewerVisible, setMediaViewerVisible] = React.useState(false);
  const [selectedMedia, setSelectedMedia] = React.useState<ChatSelectedMedia | null>(null);
  const [composeViewerVisible, setComposeViewerVisible] = React.useState(false);
  const [composeAssets, setComposeAssets] = React.useState<PickedChatImage[]>([]);
  const composeAsset = composeAssets[0] || null;

  const openMediaViewer = React.useCallback((media: ChatSelectedMedia) => {
    setSelectedMedia(media);
    setMediaViewerVisible(true);
  }, []);

  const closeMediaViewer = React.useCallback(() => {
    setMediaViewerVisible(false);
    setSelectedMedia(null);
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
    composeViewerVisible,
    setComposeViewerVisible,
    composeAsset,
    composeAssets,
    setComposeAssets,
    openComposeViewer,
    closeComposeViewer,
  };
}
