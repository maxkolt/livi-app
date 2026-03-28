import { logger } from './logger';

export type CallProviderMode = 'none' | 'custom';

type WebhookLikeRequest = {
  body?: unknown;
  header: (name: string) => string | undefined;
};

type VerifyResult = {
  ok: boolean;
  error?: string;
};

type DeliveredEvent = {
  callId: string;
  provider: string;
  payload: Record<string, unknown>;
};

interface CallProviderAdapter {
  readonly mode: CallProviderMode;
  isEnabled(): boolean;
  verifyWebhook(req: WebhookLikeRequest): VerifyResult;
  parseDeliveredEvent(body: unknown): DeliveredEvent | null;
}

const CALL_PROVIDER_WEBHOOK_SECRET = String(process.env.CALL_PROVIDER_WEBHOOK_SECRET || '').trim();

function parseMode(raw: string): CallProviderMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'custom') return 'custom';
  if (normalized === 'none') return 'none';
  return 'none';
}

export const callProviderMode: CallProviderMode = (() => {
  const fromMode = String(process.env.CALL_PROVIDER_MODE || '').trim();
  if (fromMode) return parseMode(fromMode);
  // Backward compatibility with previous boolean flag.
  const legacyEnabled = String(process.env.CALL_PROVIDER_SIGNALING_ENABLED ?? '0') === '1';
  return legacyEnabled ? 'custom' : 'none';
})();

const noneProviderAdapter: CallProviderAdapter = {
  mode: 'none',
  isEnabled: () => false,
  verifyWebhook: () => ({ ok: false, error: 'provider_disabled' }),
  parseDeliveredEvent: () => null,
};

const customProviderAdapter: CallProviderAdapter = {
  mode: 'custom',
  isEnabled: () => true,
  verifyWebhook(req) {
    if (!CALL_PROVIDER_WEBHOOK_SECRET) {
      return { ok: false, error: 'provider_webhook_secret_missing' };
    }
    const rawSecret = String(req.header('x-provider-webhook-secret') || '').trim();
    if (!rawSecret || rawSecret !== CALL_PROVIDER_WEBHOOK_SECRET) {
      return { ok: false, error: 'forbidden' };
    }
    return { ok: true };
  },
  parseDeliveredEvent(body) {
    const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const callId = String(payload.callId ?? '').trim();
    if (!callId) return null;
    const provider = String(payload.provider ?? 'custom').trim() || 'custom';
    return {
      callId,
      provider,
      payload,
    };
  },
};

export const callProviderAdapter: CallProviderAdapter =
  callProviderMode === 'custom' ? customProviderAdapter : noneProviderAdapter;

logger.info('[call:provider] configured mode', {
  mode: callProviderAdapter.mode,
  enabled: callProviderAdapter.isEnabled(),
});
