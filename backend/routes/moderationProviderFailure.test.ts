import { classifyModerationProviderFailure } from './moderation';

/**
 * Коды — gRPC-статусы Google Vision. Смысл разбора: отличить «провайдер недоступен
 * или не настроен» от ошибки в нашем коде. Первое — это 503 с Retry-After, клиент
 * отступает и продолжает прятать непроверённое видео; второе — честный 500.
 */
describe('classifyModerationProviderFailure', () => {
  it('7 + billing — проблема оплаты, отступать надолго', () => {
    const r = classifyModerationProviderFailure({ code: 7, message: 'Billing account not configured' });
    expect(r?.publicError).toBe('moderation_provider_billing_required');
    expect(r?.retryAfterSeconds).toBe(300);
  });

  it('billing распознаётся независимо от регистра', () => {
    const r = classifyModerationProviderFailure({ code: 7, message: 'BILLING disabled for project' });
    expect(r?.publicError).toBe('moderation_provider_billing_required');
  });

  it('7 без billing — отказ в доступе', () => {
    const r = classifyModerationProviderFailure({ code: 7, message: 'permission denied' });
    expect(r?.publicError).toBe('moderation_provider_permission_denied');
    expect(r?.retryAfterSeconds).toBe(300);
  });

  it('8 — исчерпана квота, отступать минуту', () => {
    const r = classifyModerationProviderFailure({ code: 8, message: 'quota exceeded' });
    expect(r?.publicError).toBe('moderation_provider_quota_exceeded');
    expect(r?.retryAfterSeconds).toBe(60);
  });

  it.each([4, 14])('%d — временная недоступность, отступать коротко', (code) => {
    const r = classifyModerationProviderFailure({ code, message: 'unavailable' });
    expect(r?.publicError).toBe('moderation_provider_unavailable');
    expect(r?.retryAfterSeconds).toBe(30);
  });

  it('код строкой тоже разбирается — gRPC отдаёт его по-разному', () => {
    expect(classifyModerationProviderFailure({ code: '8', message: 'quota' })?.publicError).toBe(
      'moderation_provider_quota_exceeded',
    );
  });

  it('наша собственная ошибка провайдером не считается — пусть будет 500', () => {
    expect(classifyModerationProviderFailure(new Error('boom'))).toBeNull();
    expect(classifyModerationProviderFailure({ code: 3, message: 'invalid argument' })).toBeNull();
    expect(classifyModerationProviderFailure(null)).toBeNull();
    expect(classifyModerationProviderFailure(undefined)).toBeNull();
  });

  it('message может отсутствовать — не падаем', () => {
    expect(classifyModerationProviderFailure({ code: 7 })?.publicError).toBe(
      'moderation_provider_permission_denied',
    );
  });
});
