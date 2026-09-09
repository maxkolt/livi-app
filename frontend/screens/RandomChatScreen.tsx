import React, { useRef } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import RandomChat from '../components/VideoChat/RandomChat';
import type { RootStackParamList } from '../navigation/types';
import { logger } from '../utils/logger';

type Props = NativeStackScreenProps<RootStackParamList, 'RandomChat'>;

const RandomChatScreen: React.FC<Props> = ({ route }) => {
  const firstRenderLoggedRef = useRef(false);
  if (!firstRenderLoggedRef.current) {
    firstRenderLoggedRef.current = true;
    try {
      const now = Date.now();
      const g = global as any;
      const t0 = Number(g.__searchNavT0 || now);
      const steps = Array.isArray(g.__searchNavSteps) ? g.__searchNavSteps : [];
      steps.push({ step: 'RandomChatScreen.firstRender', at: now, elapsedMs: now - t0 });
      g.__searchNavSteps = steps;
      logger.info('[search-nav] RandomChatScreen.firstRender', {
        elapsedMs: now - t0,
        steps,
      });
    } catch {}
  }
  return <RandomChat route={route} />;
};

export default RandomChatScreen;

