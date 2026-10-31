import { createHash, timingSafeEqual } from 'crypto';

export type IntellectMoneyConfig = {
  eshopId: string;
  secretKey: string;
  currency: 'TST' | 'RUB';
  publicBaseUrl: string;
};

export function intellectMoneyConfig(env: NodeJS.ProcessEnv = process.env): IntellectMoneyConfig {
  const eshopId = String(env.INTELLECTMONEY_ESHOP_ID || '').trim();
  const secretKey = env.INTELLECTMONEY_SECRET_KEY || '';
  const currency = String(env.INTELLECTMONEY_CURRENCY || 'TST').trim().toUpperCase();
  if (!/^\d{1,6}$/.test(eshopId) || !secretKey || secretKey.length > 50 ||
      secretKey === 'ТВОЙ_SECRET_KEY_ИЗ_КАБИНЕТА') throw new Error('intellectmoney_not_configured');
  if (currency !== 'TST' && currency !== 'RUB') throw new Error('intellectmoney_invalid_currency');
  const base = new URL(env.PUBLIC_BASE_URL || 'https://api.liviapp.com');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      base.pathname !== '/') throw new Error('intellectmoney_invalid_public_url');
  return { eshopId, secretKey, currency, publicBaseUrl: base.origin };
}

export type IntellectMoneyOrder = {
  paymentId: string;
  eshopId: string;
  amount: string;
  currency: 'TST' | 'RUB';
  serviceName: string;
  expiresAt: Date;
};

function md5(values: string[]): string {
  return createHash('md5').update(values.join('::'), 'utf8').digest('hex');
}

/** Official HTML-form PurchaseHash; no secret is sent to the browser. */
export function intellectMoneyPurchaseHash(order: IntellectMoneyOrder, secretKey: string): string {
  return md5([order.eshopId, order.paymentId, order.serviceName, order.amount, order.currency, secretKey]);
}

export function intellectMoneyCheckoutUrl(config: IntellectMoneyConfig, paymentId: string): string {
  return `${config.publicBaseUrl}/api/cosmetics/intellectmoney/checkout/${encodeURIComponent(paymentId)}`;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function moscowDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function intellectMoneyCheckoutHtml(order: IntellectMoneyOrder, config: IntellectMoneyConfig): string {
  const returnUrl = `${config.publicBaseUrl}/api/cosmetics/payment-return`;
  const fields: Record<string, string> = {
    EshopId: order.eshopId, OrderId: order.paymentId, ServiceName: order.serviceName,
    RecipientAmount: order.amount, RecipientCurrency: order.currency,
    SuccessUrl: returnUrl, BackUrl: returnUrl,
    ResultUrl: `${config.publicBaseUrl}/api/cosmetics/intellectmoney/webhook`,
    HoldMode: '0', ExpireDate: moscowDate(order.expiresAt),
    PurchaseHash: intellectMoneyPurchaseHash(order, config.secretKey),
  };
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LiVi — Legendary</title>
<style>body{margin:0;background:#252b34;color:#fff;font:17px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;width:min(92vw,420px);padding:28px;border-radius:24px;background:#344252}h1{font-size:24px}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;padding:14px;border:0;border-radius:12px;font:inherit}button{margin-top:18px;background:#50a5d0;color:#10202b;font-weight:600;cursor:pointer}p{line-height:1.5}a{color:#7fc4e8}.muted{color:#c1cbd8;font-size:14px}</style>
</head><body><main><h1>LiVi · Legendary</h1><p>${html(order.serviceName)}</p>
<p>${html(order.amount)} ${order.currency === 'TST' ? 'TST · тестовая оплата' : '₽'}</p>
<form method="post" action="https://merchant.intellectmoney.ru/" accept-charset="UTF-8">
${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${key}" value="${html(value)}">`).join('\n')}
<label for="email">Email для подтверждения оплаты</label>
<input id="email" name="Email" type="email" autocomplete="email" maxlength="100" required>
<button type="submit">Перейти к оплате</button></form>
<p class="muted">Оплата на защищённой странице IntellectMoney. Данные карты не передаются LiVi.</p>
<a href="${html(returnUrl)}">Вернуться в LiVi</a></main></body></html>`;
}

/** Accept decimal formatting differences without floating-point rounding or fractional kopecks. */
export function intellectMoneyAmount(value: string): string | null {
  const match = /^(\d{1,10})(?:\.(\d{1,4}))?$/.exec(value);
  if (!match || /[1-9]/.test((match[2] || '').slice(2))) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0').slice(0, 2));
  return cents.toString();
}

export type IntellectMoneyNotification = {
  eshopId: string;
  orderId: string;
  invoiceId: string;
  amount: string;
  currency: 'TST' | 'RUB';
  status: '3' | '4' | '5' | '6' | '7' | '8';
};

export function verifyIntellectMoneyNotification(
  body: unknown, config: IntellectMoneyConfig,
): IntellectMoneyNotification | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    if (typeof value !== 'string' || value.length > 4096 || lower in fields) return null;
    fields[lower] = value;
  }
  const signatureFields = ['eshopid', 'orderid', 'servicename', 'eshopaccount', 'recipientamount',
    'recipientcurrency', 'paymentstatus', 'username', 'useremail', 'paymentdata'];
  if (!/^[a-fA-F0-9]{32}$/.test(fields.hash || '')) return null;
  const expected = md5([...signatureFields.map(key => fields[key] || ''), config.secretKey]);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(fields.hash, 'hex'))) return null;
  const currency = fields.recipientcurrency === 'RUR' ? 'RUB' : fields.recipientcurrency;
  if (fields.eshopid !== config.eshopId || !/^im_[a-f0-9-]{36}$/.test(fields.orderid || '') ||
      !/^\d{1,20}$/.test(fields.paymentid || '') || !/^[345678]$/.test(fields.paymentstatus || '') ||
      !fields.eshopaccount || !fields.useremail || !fields.paymentdata ||
      (currency !== 'TST' && currency !== 'RUB') || !intellectMoneyAmount(fields.recipientamount || '')) return null;
  return {
    eshopId: fields.eshopid, orderId: fields.orderid, invoiceId: fields.paymentid,
    amount: fields.recipientamount, currency, status: fields.paymentstatus as IntellectMoneyNotification['status'],
  };
}
