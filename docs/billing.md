# Billing

## Self-serve changes

The billing methods on `ServerCustomer` act as the customer choosing for themselves in your own
interface, so each sends `"selfServe": true`. The change must then be among the plans the customer can move to
(`plans()`), along a self-serve path, or Entitler refuses it with `403 not_self_serve`.

A plan is named by its key or public id, or replaced by a SKU the customer bought, which names its own
period. A period is named by its label exactly as pricing shows it (`Monthly`, `Yearly`):

```ts
await customer.subscribe("pro", { period: "Yearly" });
await customer.subscribe({ sku: { connector: "stripe", ids: { priceId: "price_123" } } });
await customer.addAddOn("sso_addon");
await customer.setAddOnQuantity("extra_seats", 5);
await customer.removeAddOn("sso_addon");
await customer.undoAddOnChange("sso_addon");
await customer.cancel({ when: "end" });
await customer.undoPendingChange();
```

A downgrade is usually booked for the end of the period, in `subscription.pending`.

## Checkout and the billing portal

```ts
import { ApiError } from "@entitlerhq/entitler";

try {
  const checkout = await customer.checkout("pro", {
    successUrl: "https://app.example.com/billing/done",
    cancelUrl: "https://app.example.com/billing",
  });
  console.log(`Redirect to ${checkout.url}`);
  const portal = await customer.billingPortal({ returnUrl: "https://app.example.com/account" });
  console.log(`Redirect to ${portal.url}`);
} catch (error) {
  if (error instanceof ApiError && error.code === "payment_required") console.log(error.payment?.url);
  else if (error instanceof ApiError && error.code === "stale") console.log("No payment provider connected.");
  else throw error;
}
```

`billing()` reads the customer's billing on the payment provider, and `providers()` what each
provider connection holds.

## Vendor actions

Changes your team makes on the customer's behalf live apart, under `vendor`, so they are never made by
accident and are easy to find in review. They send `"selfServe": false`, so the vendor may move the
customer anywhere, sales-led plans included.

```ts
await customer.vendor.subscribe("enterprise");
await customer.vendor.override("pro", { period: "Monthly" });
await customer.vendor.undoOverride();
await customer.vendor.addAddOn("support_premium");
await customer.vendor.setAddOnQuantity("extra_seats", 20);
const details = await customer.vendor.grant(features.sso, { days: 30, reason: "Pilot" });
const grant = details.grants.find((each) => each.feature === "sso");
if (grant) await customer.vendor.revokeGrant(grant.id);
await customer.vendor.setMeter(features.aiCredits, 0);
await customer.vendor.cancelUsage("use_123");
```

`override` moves the customer in Entitler only, while the payment provider keeps billing the plan they
held. `setMeter` answers `outcome: "adjusted"`, and `cancelUsage` `outcome: "cancelled"`.
