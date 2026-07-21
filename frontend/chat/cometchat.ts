/**
 * CometChat legacy shim.
 *
 * Messaging runs over our socket backend. The old CometChat SDK is no longer
 * initialized or contacted from JS. Call sites keep the same exports so App /
 * Home / RandomChat boot paths stay unchanged (no-ops).
 *
 * Native packages may still be linked until a separate uninstall PR.
 */

/** Kept for App boot — previously initialized the CometChat SDK. */
export async function ensureCometChatReady(): Promise<void> {
  return;
}

/** Kept for App userId ready path — previously logged into CometChat. */
export async function connectStreamIfNeeded(
  _userId?: string,
  _userProfile?: { nick?: string; avatarUrl?: string },
): Promise<void> {
  return;
}

/** Kept for Home / RandomChat profile updates — previously synced nick/avatar to CometChat. */
export async function syncMyStreamProfile(
  _nick?: string,
  _avatarUrl?: string,
): Promise<void> {
  return;
}
