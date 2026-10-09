# Billing pages

A billing page, a paywall and an upgrade prompt all read one answer, `plans()`, and act on it with
the customer's own choices: `subscribe`, `cancel`, `undoPendingChange`, `billingPortal` and
`syncBilling`. They work the same on `server.customer(id)` and on an in-app client's `me`.

## One read: `plans()`

`plans()` answers the plans the customer holds (`held`) and the moves open to them (`options`):

- each held plan's `period` (`{ key, label }`), `renewsAt`, `pending` (a move or a cancel booked for
  `renewsAt`) and `billedBy` (`stripe`, `apple`, `google`, or `null` when nothing bills it);
- each option's `move` (`subscribe`, `upgrade`, `downgrade`, `switch`, `add` or `replace`), its
  `action`, its `periods`, its `impact` on the customer's features and limits, and its `skus`.

`action` decides the button: `buy` when the customer can make the move alone, `contact` for a
sales-led move only your team can make, and `unavailable` (with `reason`, a sentence for you, not
the customer) for neither. `billedBy` decides where the customer manages a plan: the App Store or
Google Play's own page for `apple` and `google`, and the billing portal for `stripe`.

```ts
const plans = await customer.plans();
for (const held of plans.held) {
  console.log(`${held.plan.name}, ${held.period?.label ?? "no period"}, billed by ${held.billedBy ?? "nobody"}`);
}
for (const option of plans.options) {
  if (option.action === "buy") console.log(`${option.move} to ${option.plan.name}`);
  if (option.action === "contact") console.log(`Talk to sales about ${option.plan.name}`);
}
```

The same `move` and `action` appear on a check's `upgrades`, so the button on a refused export and
the paywall follow one rule. On the in-app client, `plans()` and the billing calls below need the
organisation's customer portal capability (`409 capability_required` otherwise).

## Subscribing: the next step

`subscribe` moves the customer to a plan, or adds an add-on (`quantity` for a countable one), under
self-serve rules: the move must be among `plans()`'s options, or Entitler answers
`403 not_self_serve`. Your project's policies decide when it takes effect. A period is named by its
key (`monthly`, `yearly`), which stays the same when its label is renamed or translated.

It answers a step, by `next`:

```ts
const step = await customer.subscribe("pro", {
  period: "monthly",
  returnUrl: "https://app.example.com/billing/return",
});
switch (step.next) {
  case "done":
    console.log(step.effective === "now" ? "Upgraded." : `Changes on ${step.at.toDateString()}.`);
    break;
  case "pay":
    console.log(`Send the customer to ${step.url}`);
    break;
  case "confirming":
    console.log("The bank is confirming the payment. Show the change as pending.");
    break;
  case "manage":
    console.log(`The customer changes this plan through ${step.billedBy}.`);
    break;
  case "unknown":
    console.log(`A step this SDK does not know: ${step.raw}`);
    break;
}
```

`pay` sends the customer to Stripe Checkout, or to a confirmation such as 3-D Secure. An in-app
client never charges a saved card: its paid changes always answer `pay`, so the customer confirms
on the provider's page. A declined card is an error, `402 payment_required` with
`payment.status` `declined`.

### Return URLs

`returnUrl` is optional, and matters only when the next step is a web page: the provider sends the
customer back to it whether they paid or left. A change that needs a page and has no `returnUrl` is
refused with `400 return_url_required` before anything changes, so pass one whenever Stripe may bill
the customer.

- A web app passes a page of its own.
- A mobile app billed through Stripe passes a universal link (iOS) or an app link (Android), and
  opens the `pay` step's `url` in `ASWebAuthenticationSession` or a Custom Tab.
- An app whose plans a store bills never calls `subscribe`: see [store purchases](store-purchases.md).

### The return page

Back from the provider, call `syncBilling()` and then `plans({ revalidate: true })`, so the customer
sees the plan they paid for without waiting for the provider's notification:

```ts
await customer.syncBilling();
const current = await customer.plans({ revalidate: true });
console.log(current.held.map((held) => held.plan.name).join(", "));
```

## Cancelling and undoing

`cancel()` cancels the plan, or with `addOn` an add-on, as the customer's own choice; the project's
cancel policy decides whether it ends now or at renewal. `undoPendingChange()` takes back the change
booked for renewal. Pass `product` when the customer holds plans in several products, never with
`addOn`. Each answers a `PlanChange`, whose `changed` is false when there was nothing to do:

```ts
const cancel = await customer.cancel();
if (cancel.effective === "renewal") console.log(`Ends on ${cancel.at.toDateString()}.`);
await customer.undoPendingChange();
await customer.cancel({ addOn: "sso_addon" });
```

## The billing portal

`billingPortal({ returnUrl })` opens the provider's page for payment details and invoices. It changes
no plan, and a customer the provider has never billed answers `409 stale`:

```ts
import { ApiError } from "@entitlerhq/entitler";

try {
  const portal = await customer.billingPortal({ returnUrl: "https://app.example.com/account" });
  console.log(`Send the customer to ${portal.url}`);
} catch (error) {
  if (!(error instanceof ApiError && error.code === "stale")) throw error;
  console.log("Nothing billed yet, so there is no portal.");
}
```

## In an app: `billing:self`

On the in-app client these calls need the `billing:self` scope, which `token({ scopes })` grants only
when asked. Mint it only for people who may buy for the customer (a workspace's owners, not every
member); without it, Entitler answers `403 scope_required`.

## Error codes

| Call | Codes |
| --- | --- |
| `subscribe` | `400 invalid_body`, `400 return_url_required`, `402 payment_required`, `403 not_self_serve`, `403 scope_required`, `404 customer_not_found`, `409 capability_required`, `503` |
| `cancel`, `undoPendingChange` | `403 not_self_serve`, `403 scope_required`, `404 customer_not_found`, `409 capability_required` |
| `billingPortal` | `403 scope_required`, `409 stale`, `409 capability_required` |
| `syncBilling` | `403 scope_required`, `409 capability_required`, `429 rate_limited`, `503` |
| `setPlan` | `400 invalid_body`, `402 payment_required`, `404 customer_not_found`, `409 billed_elsewhere`, `503` |
| `setAddOn` | `400 invalid_body`, `402 payment_required`, `404 not_found`, `404 customer_not_found` |

API messages are written for you, the developer, not for the customer. See
[company decisions](company-decisions.md) for the changes your team makes.
