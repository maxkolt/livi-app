type CallLinkAction = 'incoming-call' | 'answer-call' | 'decline-call' | 'cancel-outgoing';

export type InternalCallLink = {
  action: CallLinkAction;
  callId: string;
  from: string;
  fromNick: string;
};

/** Match the URI itself, never a call command embedded inside another URL. */
export function parseInternalCallLink(url: string): InternalCallLink | null {
  const match = /^livi:\/\/(incoming-call|answer-call|decline-call|cancel-outgoing)\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(url);
  if (!match) return null;
  const action = match[1].toLowerCase() as CallLinkAction;
  const params = new URLSearchParams(match[2] || '');
  const callId = params.get('callId') || params.get('call_id') || '';
  const from = params.get('from') || params.get('userId') || '';
  if (!callId || ((action === 'incoming-call' || action === 'answer-call') && !from)) return null;
  return { action, callId, from, fromNick: params.get('fromNick') ?? '' };
}

/** Public Android invitations use the verified host; legacy links remain for iOS/debug. */
export function parseInviteCodeFromLink(url: string): string | null {
  const web = /^https:\/\/api\.liviapp\.com(?::443)?\/invite\/([a-f\d]{24})\/?(?:[?#].*)?$/i.exec(url);
  if (web) return web[1];
  const legacy = /^livi:\/\/invite\/([a-f\d]{24})\/?(?:[?#].*)?$/i.exec(url);
  return legacy?.[1] ?? null;
}
