/** Media viewer + compose preview + attach sheet visibility. */

import React from "react";

export type ChatSelectedMedia = {
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
  const [composeAsset, setComposeAsset] = React.useState<any>(null);
  const [showAttachSheet, setShowAttachSheet] = React.useState(false);

  const openMediaViewer = React.useCallback((media: ChatSelectedMedia) => {
    setSelectedMedia(media);
    setMediaViewerVisible(true);
  }, []);

  const closeMediaViewer = React.useCallback(() => {
    setMediaViewerVisible(false);
    setSelectedMedia(null);
  }, []);

  const openComposeViewer = React.useCallback((asset: any) => {
    setComposeAsset(asset);
    setComposeViewerVisible(true);
  }, []);

  const closeComposeViewer = React.useCallback(() => {
    setComposeViewerVisible(false);
    setComposeAsset(null);
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
    setComposeAsset,
    openComposeViewer,
    closeComposeViewer,
    showAttachSheet,
    setShowAttachSheet,
  };
}
