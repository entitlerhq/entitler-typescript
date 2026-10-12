# Pricing pages and visitors

## Signed-out pricing with a publishable key

An app's signed-out paywall or pricing page reads pricing straight from Entitler with a publishable
key (`ent_pk_live_…`), which holds product scopes only and is safe to ship:

```ts
import { EntitlerClient } from "@entitlerhq/entitler";

const signedOut = new EntitlerClient({ key: "ent_pk_live_…" });
const pricing = await signedOut.pricing();
for (const plan of pricing.plans) console.log(plan.name, plan.periods.map((period) => period.label));
```

A pricing page served from your own server reads `server.pricing({ visitor })` instead. Pricing is
always computed now and goes through the answer cache.

## Visitors

A visitor id keeps a person in the same experiment arm on every page and after they sign up. It
matches `VISITOR_ID_PATTERN` (16 to 64 letters, numbers, hyphens or underscores).

- On a server, the SDK never generates or keeps a visitor, because one server serves many visitors.
  Mint one with `newVisitorId()`, keep it for the visitor in a first-party cookie, and pass it to
  `server.pricing({ visitor })`, `customer.pricing({ visitor })` and `customer.register({ visitor })`.
- In an app, the in-app client sends its visitor on every request. In browsers a generated id is kept
  in `localStorage` under `entitler.visitor`, written only when a call sends it; elsewhere it lives
  for the client's lifetime. Pass `visitor` to use your own.

```ts
import { newVisitorId, VISITOR_ID_PATTERN } from "@entitlerhq/entitler";

const fromCookie = cookies.get("visitor");
const id = fromCookie && VISITOR_ID_PATTERN.test(fromCookie) ? fromCookie : newVisitorId();
await server.customer("user_123").register({ visitor: id });
```

## The visitor through sign-up

The signed-out screen's visitor goes into your app's own sign-up request, and your server passes it
to `register({ visitor })`, so the experiment arm stays the same. At sign-out and at account
deletion, reset it, so the next person on a shared device is never linked to the last:

```ts
import { resetStoredVisitor, storedVisitorId } from "@entitlerhq/entitler";

await fetch("/api/sign-up", { method: "POST", body: JSON.stringify({ visitor: storedVisitorId() }) });
resetStoredVisitor();
```

## A signed-in customer's pricing

`customer.pricing()` answers the pricing on sale to that customer, through the cache.

```ts
const offer = await customer.pricing();
console.log(offer.defaultPlan, offer.plans.length);
```

The [pricing-page example](../examples/pricing-page/index.ts) prints a pricing page both ways.
