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

export const INTELLECTMONEY_WIDGET_SCRIPT = 'https://merchant.intellectmoney.ru/v2/js/IntellectMoneyMerchantWidget.js';

export function intellectMoneyCheckoutCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}' https://merchant.intellectmoney.ru; style-src 'unsafe-inline'; img-src https://merchant.intellectmoney.ru data:; frame-src https://merchant.intellectmoney.ru; connect-src https://merchant.intellectmoney.ru; form-action https://merchant.intellectmoney.ru; base-uri 'none'; frame-ancestors 'none'`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// The same tealDeep palette and cosine fade as WelcomeStageBackground.tsx.
function legendaryBackground(): string {
  const middle = [37, 43, 52], edge = [40, 46, 56];
  const stops = Array.from({ length: 33 }, (_, index) => {
    const position = index / 32;
    const distance = Math.min(1, Math.max(0, (Math.abs(position - 0.5) * 2 - 0.3) / 0.7));
    const mix = (1 - Math.cos(Math.PI * distance)) / 2;
    const rgb = middle.map((color, channel) => (color + (edge[channel] - color) * mix).toFixed(3));
    return `rgb(${rgb.join(',')}) ${position * 100}%`;
  });
  return `linear-gradient(180deg,${stops.join(',')})`;
}

function moscowDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function intellectMoneyCheckoutHtml(order: IntellectMoneyOrder, config: IntellectMoneyConfig, nonce: string): string {
  if (!/^[a-zA-Z0-9+/=]+$/.test(nonce)) throw new Error('intellectmoney_invalid_nonce');
  const returnUrl = `${config.publicBaseUrl}/api/cosmetics/payment-return`;
  const fields: Record<string, string> = {
    EshopId: order.eshopId, OrderId: order.paymentId, ServiceName: order.serviceName,
    RecipientAmount: order.amount, RecipientCurrency: order.currency,
    SuccessUrl: returnUrl, BackUrl: returnUrl,
    ResultUrl: `${config.publicBaseUrl}/api/cosmetics/intellectmoney/webhook`,
    HoldMode: '0', ExpireDate: moscowDate(order.expiresAt),
    // Merchant's HTML checkout requires Hash when the shop enables RequireHash.
    // Keep PurchaseHash for widget versions using that alias as well.
    Hash: intellectMoneyPurchaseHash(order, config.secretKey),
    PurchaseHash: intellectMoneyPurchaseHash(order, config.secretKey),
  };
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light"><title>LiVi — Legendary</title>
<style>
html{min-height:100%;background:#252b34}body{margin:0;min-height:100vh;min-height:100dvh;background:${legendaryBackground()};background-attachment:fixed;font:16px system-ui,sans-serif;color:#fff}
[hidden]{display:none!important}#checkout-error{max-width:320px;margin:35vh auto 0;padding:20px;text-align:center}#checkout-error a{color:#83c8e8}
/* Keep the provider's form intact; only its outer modal sits on the LiVi background. */
#intellectmoney__widget__modal{background:transparent!important}
#intellectmoney__widget__modal-content{box-sizing:border-box;width:calc(100% - 32px);max-width:480px;min-height:100vh;min-height:100dvh;height:auto!important;margin:0 auto!important;padding:24px 0}
#intellectmoney__widget__wraper_modal-frame{height:auto!important;background:transparent!important;overflow:visible!important}
#iFrameIm{min-height:490px!important;max-height:none!important;border-radius:24px!important;color-scheme:light}
</style>
<script defer src="${INTELLECTMONEY_WIDGET_SCRIPT}"></script>
</head><body>
<p id="checkout-error" role="alert" hidden>Не удалось открыть оплату. <a href="">Повторить</a></p>
<noscript>Для открытия оплаты включите JavaScript в браузере.</noscript>
<script nonce="${nonce}">
(function(){
  var started=false;
  function unavailable(){if(!started)document.getElementById('checkout-error').hidden=false;}
  var timeout=setTimeout(unavailable,15000);
  window.addEventListener('load',function(){
    var widget=window.IntellectMoneyMerchantWidget;
    if(!widget||!widget.Configuration){clearTimeout(timeout);unavailable();return;}
    function returnToApp(){window.location.assign(${scriptJson(returnUrl)});}
    try{
      widget.Configuration.init(${scriptJson(fields)},{onSuccess:returnToApp,onClosedWindow:returnToApp});
      started=true;clearTimeout(timeout);document.getElementById('checkout-error').hidden=true;
    }catch(_){clearTimeout(timeout);unavailable();}
  });
})();
</script></body></html>`;
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
