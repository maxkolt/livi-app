import React from 'react';
import { useProtectedMediaUri } from '../../hooks/useProtectedMediaUri';
import { Image as ExpoImage, type ImageProps } from 'expo-image';
import {
  chatPhotoPreviewLayout, validChatPhotoDimensions, peekChatPhotoDimensions,
  rememberChatPhotoDimensions, resolveChatPhotoDimensions,
} from './chatPhotoDimensions';
export { chatPhotoBubbleWidth, chatPhotoPreviewLayout } from './chatPhotoDimensions';

/** Sender metadata fixes geometry on the first render; old image dimensions are cached across navigation. */
export function useChatPhotoPreviewLayout(uri: string, width: unknown, height: unknown, layoutWidth: number, viewportHeight: number) {
  const metadata = validChatPhotoDimensions(width, height);
  const [resolved, setResolved] = React.useState(() => ({ uri, dimensions: peekChatPhotoDimensions(uri) }));
  const dimensions = metadata || (resolved.uri === uri ? resolved.dimensions : null) || peekChatPhotoDimensions(uri);
  React.useEffect(() => {
    if (!uri) return;
    if (validChatPhotoDimensions(width, height)) {
      rememberChatPhotoDimensions(uri, width, height);
      return;
    }
    let alive = true;
    void resolveChatPhotoDimensions(uri).then(next => {
      if (alive && next) setResolved({ uri, dimensions: next });
    });
    return () => { alive = false; };
  }, [uri, width, height]);
  return chatPhotoPreviewLayout(layoutWidth, dimensions, viewportHeight);
}

type Props = Omit<ImageProps, 'contentFit' | 'placeholderContentFit' | 'transition'>;

/** Complete photo content remains visible while dimensions are discovered or a legacy message loads. */
export function ChatPhotoPreviewImage(props: Props) {
  const source = props.source;
  const rawUri = source && typeof source === 'object' && !Array.isArray(source) && 'uri' in source ? String(source.uri || '') : '';
  return rawUri.includes('/uploads/media/') ? <ProtectedPhotoImage {...props} rawUri={rawUri} /> : <ExpoImage {...props} contentFit="contain" placeholderContentFit="contain" transition={0} />;
}
function ProtectedPhotoImage({ rawUri, ...props }: Props & { rawUri: string }) {
  const uri = useProtectedMediaUri(rawUri);
  return <ExpoImage {...props} source={uri ? { uri } : undefined} contentFit="contain" placeholderContentFit="contain" transition={0} />;
}
