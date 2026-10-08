/**
 * Последний список друзей в памяти — для экранов, которым он нужен сразу, без похода в
 * AsyncStorage/сервер (экран отправки «Поделиться»: после возврата из фона JS занят, и
 * любой асинхронный ответ ждёт в очереди). Обновляет useHomeFriends.
 */
export type FriendSnapshotRow = {
  id: string;
  name: string;
  avatarVer: number;
  avatarThumbB64: string;
};

let snapshot: FriendSnapshotRow[] = [];

export function setFriendsSnapshot(list: FriendSnapshotRow[]): void {
  snapshot = list;
}

export function getFriendsSnapshot(): FriendSnapshotRow[] {
  return snapshot;
}
