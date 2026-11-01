import { createHash } from 'crypto';
import { runInNewContext } from 'vm';
import {
  intellectMoneyConfig, intellectMoneyPurchaseHash, intellectMoneyCheckoutHtml,
  intellectMoneyAmount, intellectMoneyCheckoutCsp, verifyIntellectMoneyNotification, type IntellectMoneyConfig,
} from './intellectMoney';

const config: IntellectMoneyConfig = {
  eshopId: '473314', secretKey: 'test-only-secret', currency: 'TST', publicBaseUrl: 'https://api.liviapp.com',
};
const paymentId = 'im_00000000-0000-4000-8000-000000000001';
const nonce = 'testNonce123';
const checkoutOrder = { paymentId, eshopId: config.eshopId, serviceName: 'Рамка Legendary: fire',
  amount: '199.00', currency: 'TST' as const, expiresAt: new Date('2026-11-01T18:00:00Z') };
function bootCheckout(page: string, init?: jest.Mock) {
  let loaded = () => {};
  const error = { hidden: true };
  const location = { assign: jest.fn() };
  const window = {
    IntellectMoneyMerchantWidget: init ? { Configuration: { init } } : undefined,
    addEventListener: jest.fn((_event, callback) => { loaded = callback; }), location,
  };
  const source = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (!source) throw Error('Missing widget bootstrap');
  runInNewContext(source, { window, document: { getElementById: () => error }, setTimeout: jest.fn(), clearTimeout: jest.fn() });
  loaded();
  return { error, location };
}
function notification(overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    EshopId: '473314', OrderId: paymentId, ServiceName: 'Рамка Legendary: fire', EshopAccount: '12345',
    RecipientAmount: '199.00', RecipientCurrency: 'TST', PaymentStatus: '5',
    UserName: '', UserEmail: 'buyer@example.com', PaymentData: '2026-10-31 21:00:00', PaymentId: '3000000001',
    ...overrides,
  };
  fields.Hash = createHash('md5').update([
    fields.EshopId, fields.OrderId, fields.ServiceName, fields.EshopAccount, fields.RecipientAmount,
    fields.RecipientCurrency, fields.PaymentStatus, fields.UserName, fields.UserEmail, fields.PaymentData,
    config.secretKey,
  ].join('::'), 'utf8').digest('hex');
  return fields;
}

describe('IntellectMoney configuration and checkout', () => {
  it('defaults to test currency and requires the merchant key', () => {
    expect(() => intellectMoneyConfig({})).toThrow('intellectmoney_not_configured');
    expect(intellectMoneyConfig({ INTELLECTMONEY_ESHOP_ID: '473314', INTELLECTMONEY_SECRET_KEY: config.secretKey }).currency).toBe('TST');
  });
  it('does not use old YooKassa credentials as a fallback', () => {
    expect(() => intellectMoneyConfig({ YUKASSA_SHOP_ID: '473314', YUKASSA_SECRET_KEY: 'old-key' }))
      .toThrow('intellectmoney_not_configured');
  });
  it.each(['USD', 'RUR', 'anything'])('rejects an unsupported configured currency: %s', currency => {
    expect(() => intellectMoneyConfig({
      INTELLECTMONEY_ESHOP_ID: '473314', INTELLECTMONEY_SECRET_KEY: config.secretKey, INTELLECTMONEY_CURRENCY: currency,
    })).toThrow('intellectmoney_invalid_currency');
  });
  it.each(['http://api.liviapp.com', 'https://user:password@api.liviapp.com', 'https://api.liviapp.com/?bad=1'])(
  'rejects unsafe callback bases: %s', url => {
    expect(() => intellectMoneyConfig({
      INTELLECTMONEY_ESHOP_ID: '473314', INTELLECTMONEY_SECRET_KEY: config.secretKey, PUBLIC_BASE_URL: url,
    })).toThrow('intellectmoney_invalid_public_url');
  });
  it('signs the canonical shop/order/description/amount/currency sequence with UTF-8', () => {
    const expected = createHash('md5')
      .update(`473314::${paymentId}::Рамка Legendary: fire::199.00::TST::test-only-secret`, 'utf8').digest('hex');
    expect(intellectMoneyPurchaseHash(checkoutOrder, config.secretKey)).toBe(expected);
    const page = intellectMoneyCheckoutHtml(checkoutOrder, config, nonce);
    const init = jest.fn();
    bootCheckout(page, init);
    expect(page).toContain('src="https://merchant.intellectmoney.ru/v2/js/IntellectMoneyMerchantWidget.js"');
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      EshopId: '473314', OrderId: paymentId, RecipientAmount: '199.00', RecipientCurrency: 'TST',
      Hash: expected, PurchaseHash: expected, ExpireDate: '2026-11-01 21:00:00',
      ResultUrl: 'https://api.liviapp.com/api/cosmetics/intellectmoney/webhook',
    }), expect.any(Object));
    expect(page).not.toContain('<form');
    expect(page).not.toContain('Перейти к оплате');
    expect(page).not.toContain('<h1>');
    expect(page).not.toContain(config.secretKey);
    expect(page).not.toContain('yookassa');
  });
  it('escapes script termination and preserves the description passed to the official widget', () => {
    const description = '</script><script>alert(1)</script>\u2028&';
    const page = intellectMoneyCheckoutHtml({
      ...checkoutOrder, serviceName: description,
    }, config, nonce);
    expect(page).not.toContain(description);
    const init = jest.fn();
    bootCheckout(page, init);
    expect(init.mock.calls[0][0].ServiceName).toBe(description);
  });
  it('passes explicitly selected RUB and its matching signature without silently falling back to TST', () => {
    const rubConfig = intellectMoneyConfig({
      INTELLECTMONEY_ESHOP_ID: config.eshopId, INTELLECTMONEY_SECRET_KEY: config.secretKey,
      INTELLECTMONEY_CURRENCY: 'RUB',
    });
    const rubOrder = { ...checkoutOrder, currency: rubConfig.currency };
    const init = jest.fn();
    bootCheckout(intellectMoneyCheckoutHtml(rubOrder, rubConfig, nonce), init);
    const params = init.mock.calls[0][0];
    expect(params.RecipientCurrency).toBe('RUB');
    expect(params.Hash).toBe(params.PurchaseHash);
    expect(params.PurchaseHash).toBe(createHash('md5')
      .update(`473314::${paymentId}::Рамка Legendary: fire::199.00::RUB::test-only-secret`, 'utf8').digest('hex'));
    expect(params.PurchaseHash).not.toBe(intellectMoneyPurchaseHash(checkoutOrder, config.secretKey));
  });
  it('uses a fresh CSP nonce and permits the official script, images and iframe', () => {
    const policy = intellectMoneyCheckoutCsp(nonce);
    expect(policy).toContain(`script-src 'nonce-${nonce}' https://merchant.intellectmoney.ru;`);
    expect(policy).toContain('frame-src https://merchant.intellectmoney.ru;');
    expect(policy).toContain('img-src https://merchant.intellectmoney.ru data:;');
    expect(() => intellectMoneyCheckoutHtml(checkoutOrder, config, '\" onclick=bad')).toThrow('intellectmoney_invalid_nonce');
  });
  it.each(['success', 'close'])('returns to LiVi on widget %s without granting an item in JavaScript', event => {
    const init = jest.fn();
    const { location } = bootCheckout(intellectMoneyCheckoutHtml(checkoutOrder, config, nonce), init);
    init.mock.calls[0][1][event === 'success' ? 'onSuccess' : 'onClosedWindow']();
    expect(location.assign).toHaveBeenCalledWith('https://api.liviapp.com/api/cosmetics/payment-return');
  });
  it('shows a retry only if the provider script is unavailable', () => {
    expect(bootCheckout(intellectMoneyCheckoutHtml(checkoutOrder, config, nonce)).error.hidden).toBe(false);
    const init = jest.fn(() => { throw Error('Provider unavailable'); });
    expect(bootCheckout(intellectMoneyCheckoutHtml(checkoutOrder, config, nonce), init).error.hidden).toBe(false);
  });
});

describe('IntellectMoney amounts', () => {
  it.each(['199', '199.0', '199.00', '199.0000', '00199.00'])('normalizes %s without rounding', amount => {
    expect(intellectMoneyAmount(amount)).toBe('19900');
  });
  it.each(['199.001', '-199', '199,00', '1e2', 'NaN', ' 199.00', '199.00000', ''])('rejects %s', amount => {
    expect(intellectMoneyAmount(amount)).toBeNull();
  });
});

describe('IntellectMoney signed server notifications', () => {
  it('authenticates the documented callback, including an empty username segment', () => {
    expect(verifyIntellectMoneyNotification(notification(), config)).toMatchObject({
      orderId: paymentId, amount: '199.00', currency: 'TST', status: '5',
    });
  });
  it('accepts the lower-camel field casing used by legacy merchant notifications', () => {
    const lower = Object.fromEntries(Object.entries(notification()).map(([key, value]) => [key[0].toLowerCase() + key.slice(1), value]));
    expect(verifyIntellectMoneyNotification(lower, config)?.status).toBe('5');
  });
  it.each(['RecipientAmount', 'RecipientCurrency', 'OrderId', 'PaymentStatus', 'UserEmail'])(
  'rejects a tampered %s field', field => {
    const body = notification(); body[field] = 'tampered';
    expect(verifyIntellectMoneyNotification(body, config)).toBeNull();
  });
  it('does not trust a SecretKey supplied in the callback', () => {
    const body = notification(); body.SecretKey = config.secretKey;
    expect(verifyIntellectMoneyNotification(body, { ...config, secretKey: 'different-key' })).toBeNull();
  });
  it.each(['', 'abc', '0'.repeat(32), 'z'.repeat(32)])('rejects malformed or forged hashes: %s', hash => {
    expect(verifyIntellectMoneyNotification({ ...notification(), Hash: hash }, config)).toBeNull();
  });
  it('rejects duplicate field casing and parameter arrays', () => {
    expect(verifyIntellectMoneyNotification({ ...notification(), eshopId: '473314' }, config)).toBeNull();
    expect(verifyIntellectMoneyNotification({ ...notification(), OrderId: [paymentId] }, config)).toBeNull();
  });
  it('rejects a signed notification for another merchant', () => {
    expect(verifyIntellectMoneyNotification(notification({ EshopId: '123456' }), config)).toBeNull();
  });
  it('keeps test currency distinct from real rubles and normalizes the RUR alias', () => {
    expect(verifyIntellectMoneyNotification(notification(), config)?.currency).toBe('TST');
    expect(verifyIntellectMoneyNotification(notification({ RecipientCurrency: 'RUR' }), config)?.currency).toBe('RUB');
  });
  it.each(['3', '4', '5', '6', '7', '8'])('recognizes signed status %s without treating it as paid', status => {
    expect(verifyIntellectMoneyNotification(notification({ PaymentStatus: status }), config)?.status).toBe(status);
  });
});
