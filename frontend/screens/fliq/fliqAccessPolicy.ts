/** A missing video or an offline phone is not evidence of regional YouTube restrictions. */
export function shouldSuggestYoutubeVpn(input: {
  active: boolean;
  shown: boolean;
  connected: boolean | null;
  internetReachable: boolean | null;
  code?: number;
}): boolean {
  return input.active && !input.shown && input.connected === true && input.internetReachable !== false &&
    (input.code == null || [-1, -3].includes(input.code));
}
