import React from 'react';
import { FriendsListCore, type FriendsListCoreProps } from './FriendsListCore';

export type HomeFriendsTabProps = FriendsListCoreProps;

function HomeFriendsTabInner(props: HomeFriendsTabProps) {
  return <FriendsListCore {...props} presentation="menu" />;
}

export const HomeFriendsTab = React.memo(HomeFriendsTabInner);
