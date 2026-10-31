# Legendary: IntellectMoney

New purchases use IntellectMoney's hosted payment form. No card data or merchant key
is stored in the Android app. The checkout collects the payer's email and submits
the signed order directly to IntellectMoney. The existing Android checkout API is
preserved; updating the backend switches the provider for existing app builds too.

## Test shop 473314

Append the values in `backend/.env.payments.example` to the backend environment.
`INTELLECTMONEY_SECRET_KEY` must be exactly the SecretKey in the shop's connection
settings. Quote it if it contains spaces or `#`. Do not use an API token here.
`INTELLECTMONEY_CURRENCY=TST` is for the test account and does not charge real money.
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

Prices remain 199 for frames and 99 for backgrounds. In this shop these are TST.
Use the IntellectMoney test payment methods; real payment credentials are not needed.

## Verification

1. Open Legendary and select an unowned item, then Buy.
2. A LiVi checkout opens, showing the item and test amount. Enter an email and
   continue to the hosted IntellectMoney page.
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

Keep TST until the real account is approved and its receipt settings are configured
with IntellectMoney. RUB is a separate explicit environment setting, not an
automatic fallback. This integration does not configure fiscal receipts on behalf
of the merchant. A new live shop also requires its actual EshopId and SecretKey.

## Official protocol

- [Hosted HTML payment form](https://developer.intellectmoney.ru/protocol/html/createInvoice/)
- [Control signatures](https://developer.intellectmoney.ru/info/signature/)
- [Server notifications](https://developer.intellectmoney.ru/info/notification/)
- [Test access and TST](https://developer.intellectmoney.ru/info/access/)
