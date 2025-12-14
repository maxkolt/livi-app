import React from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import VideoCall from '../components/VideoChat/VideoCall';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'VideoCall'>;

const VideoCallScreen: React.FC<Props> = ({ route }) => {
  return <VideoCall route={route} />;
};

export default VideoCallScreen;
