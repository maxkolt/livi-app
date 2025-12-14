import React from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import RandomChat from '../components/VideoChat/RandomChat';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'RandomChat'>;

const RandomChatScreen: React.FC<Props> = ({ route }) => {
  return <RandomChat route={route} />;
};

export default RandomChatScreen;

