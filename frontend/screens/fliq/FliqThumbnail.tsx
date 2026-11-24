import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { Image, type ImageProps } from 'expo-image';
import NetInfo from '@react-native-community/netinfo';
import { usePaneResources } from '../../utils/paneVisibility';

const RETRIES_MS = [1000, 3000, 8000];

/** Bounded retries belong to the image loader, independently of the video player. */
export function FliqThumbnail({ uri, ...props }: Omit<ImageProps, 'source' | 'onError'> & { uri: string }) {
  const resources = usePaneResources();
  const [request, setRequest] = useState({ uri, attempt: 0, failed: false, epoch: 0 });
  const current = request.uri === uri ? request : { uri, attempt: 0, failed: false, epoch: request.epoch + 1 };
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    if (request.uri !== uri) setRequest({ uri, attempt: 0, failed: false, epoch: request.epoch + 1 });
  }, [request.epoch, request.uri, uri]);
  useEffect(() => {
    if (!resources || !current.failed || current.attempt >= RETRIES_MS.length) return;
    const timer = setTimeout(() => setRequest(previous => ({ ...previous, attempt: previous.attempt + 1, failed: false })), RETRIES_MS[current.attempt]);
    return () => clearTimeout(timer);
  }, [resources, current.attempt, current.failed, current.uri]);
  useEffect(() => {
    let online: boolean | undefined;
    let appState = AppState.currentState;
    const retry = () => {
      if (latest.current.failed) setRequest(previous => ({ ...previous, attempt: 0, failed: false, epoch: previous.epoch + 1 }));
    };
    const unsubscribe = NetInfo.addEventListener(state => {
      const next = state.isConnected === true && state.isInternetReachable !== false;
      if (next && online === false) retry();
      online = next;
    });
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && appState !== 'active') retry();
      appState = state;
    });
    return () => { unsubscribe(); sub.remove(); };
  }, []);
  if (!resources) return <View style={props.style} />;
  const generation = `${uri}:${current.epoch}:${current.attempt}`;
  return <Image {...props} key={generation} source={{ uri }} onError={() => {
    if (`${latest.current.uri}:${latest.current.epoch}:${latest.current.attempt}` !== generation) return;
    setRequest(previous => ({ ...previous, failed: true }));
  }} />;
}
