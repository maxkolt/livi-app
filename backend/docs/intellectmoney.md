# Legendary: IntellectMoney

New purchases open the official IntellectMoney Merchant Widget automatically on
the same tealDeep background as Legendary. There is no separate LiVi payment card,
email form, or intermediate payment button. The provider's form and branding are
preserved; only its outer modal is placed on the LiVi background. No card data or
merchant key is stored in the Android app. The existing Android checkout API is
preserved; updating the backend switches the checkout for existing app builds too.

The official SDK is loaded from
`https://merchant.intellectmoney.ru/v2/js/IntellectMoneyMerchantWidget.js`.
It opens `/v2/` in an iframe with the server-signed order and explicit currency.
The checkout CSP allows the provider's script, iframe and images; the LiVi
initializer has a fresh nonce. Success/close callbacks only return to the app and
never grant an item; the signed server notification remains authoritative.

## Test shop 473314

Append the values in `backend/.env.payments.example` to the backend environment.
`INTELLECTMONEY_SECRET_KEY` must be exactly the SecretKey in the shop's connection
settings. Quote it if it contains spaces or `#`. Do not use an API token here.
Use `INTELLECTMONEY_CURRENCY=TST`. The currency must match the account linked to
the shop, not just the balance currently selected on the cabinet's home page.
For shop 473314, General settings → Account must select **«Тестовый счёт»**
(TST account ID 4822630893). **«Счёт РСБ тестовый»** is a different account, which
was selected in the original shop screenshot. A TST balance on the first account
does not mean that the shop is linked to it. Save the correct account before
retrying the widget. The backend never changes TST to RUB automatically.
Restart the backend after changing its environment.

In IntellectMoney → Shops → 473314 → Connection settings:

- Set **Result URL** to `https://api.liviapp.com/api/cosmetics/intellectmoney/webhook`.
- Set **Success URL** and **Back URL** to `https://api.liviapp.com/api/cosmetics/payment-return`.
- Use **POST** and **UTF-8** for notifications.
- Enable **Require request data signature** (PurchaseHash).
- Keep **Accept only unique purchase numbers** enabled.
- In Notifications enable **paid (5)** and **canceled (4)** events; the handler also
  recognizes created (3), hold (6), partial payment (7), and refund (8).
- The SecretKey in the cabinet and backend must match.

Prices remain 199 for frames and 99 for backgrounds, in the configured currency.
Use the IntellectMoney test payment methods; real payment credentials are not needed.

## Verification

1. Open Legendary and select an unowned item, then Buy.
2. The official IntellectMoney widget opens immediately on the Legendary
   background. Fill in the fields requested by the provider.
3. Finish a test payment. The server validates the signed notification, merchant,
   order, amount, and currency, then adds the item and applies it.
4. Returning to LiVi refreshes the purchase. Closing/reopening the shop also loads
   entitlements from the server, even if the app was killed during payment.
5. Cancel and retry: a canceled or partial payment does not unlock the item.
6. Repeated Buy requests reuse a pending order. Repeated paid callbacks do not
   reapply an old frame over a later selection.

Returning to the app, visiting a success URL, or modifying form parameters cannot
grant an item. The server must receive the signed paid notification. If payment
stays pending, check notification delivery in the merchant cabinet and the backend
route. It must respond `HTTP 200`, `Content-Type: text/plain; charset=utf-8`, body `OK`.

The new collection is `intellectmoney_cosmetic_purchases`. Existing YooKassa
records/indexes and their status/webhook endpoints remain for outstanding old
orders. New Buy requests never fall back to YooKassa. Refund notifications are
recorded and block later paid replays; refund initiation and entitlement revocation
are not implemented by this checkout.

## Real payments

The selected merchant account determines whether payments are test or live. Moving
to a real account requires its approval and receipt settings in IntellectMoney;
changing the currency is insufficient. This integration does not configure fiscal
receipts on behalf of the merchant. A new shop requires its actual EshopId and SecretKey.

## Official protocol

- [Hosted HTML payment form](https://developer.intellectmoney.ru/protocol/html/createInvoice/)
- [Official payment widget](https://developer.intellectmoney.ru/protocol/widget/)
- [Control signatures](https://developer.intellectmoney.ru/info/signature/)
- [Server notifications](https://developer.intellectmoney.ru/info/notification/)
- [Test access and TST](https://developer.intellectmoney.ru/info/access/)
