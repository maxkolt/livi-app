/**
 * Индексный файл для VideoChat компонентов
 * Определяет, какой компонент использовать в зависимости от режима
 */

import React from 'react';
import RandomChat from './RandomChat';
import VideoCall from './VideoCall';

type Props = { 
  route?: { 
    params?: { 
      myUserId?: string;
      peerUserId?: string;
      directCall?: boolean;
      directInitiator?: boolean;
      callId?: string;
      roomId?: string;
      returnTo?: { name: string; params?: any };
      mode?: 'friend' | 'random';
      callMode?: 'friend' | 'random';
    } 
  } 
};

/**
 * Главный компонент VideoChat
 * Определяет, какой компонент использовать: RandomChat или VideoCall
 */
const VideoChat: React.FC<Props> = ({ route }) => {
  const isDirectCall = !!route?.params?.directCall;
  const mode = route?.params?.mode || route?.params?.callMode;
  
  // Если это прямой звонок другу или режим 'friend', используем VideoCall
  if (isDirectCall || mode === 'friend') {
    return <VideoCall route={route} />;
  }
  
  // Иначе используем RandomChat (по умолчанию для рандомного чата)
  return <RandomChat route={route} />;
};

export default VideoChat;

