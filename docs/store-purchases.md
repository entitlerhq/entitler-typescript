# Store purchases

Apps whose plans the App Store or Google Play bills never call `subscribe` or use a return URL: most
storefronts forbid card charges and web checkout for digital goods. The paywall buys the store's SKU
from `plans()` (each option's `skus`) through StoreKit or Play Billing, and your server records the
verified purchase. Clients never record purchases.

## The App Store

1. The app buys the SKU with StoreKit and sends the signed transaction to your server.
2. Your server verifies it with the App Store Server API.
3. It records the plan until the transaction's expiry:

```ts
await customer.setPlan(
  { sku: { connector: "apple", ids: { productId: "pro.monthly" } } },
  { until: "2026-11-09T10:00:00Z", actor: "app-store", idempotencyKey: "apple-tx-2000000812345678" },
);
```

4. On each renewal notification (App Store Server Notifications V2), verify it and send `setPlan`
   again with the new expiry. On a refund or revocation, move the customer with
   `setPlan("free", { when: "now" })`.

## Google Play

1. The app buys the SKU with Play Billing and sends the purchase token to your server.
2. Your server verifies it with the Google Play Developer API and acknowledges it.
3. It records the plan until the subscription's expiry, with `connector: "google"` and the product
   and base plan ids, and again on each Real-time developer notification of a renewal.

## Why `until`

`until` makes a missed store notification end the plan instead of keeping it for ever. A store SKU
never touches Stripe: when Stripe already bills that product, Entitler answers
`409 billed_elsewhere` and changes nothing.

## Deleting an account

`erase()` ends a Stripe subscription in the same call, but store subscriptions are invisible to
Entitler. Ask the customer to cancel through Apple or Google first, then erase them.
