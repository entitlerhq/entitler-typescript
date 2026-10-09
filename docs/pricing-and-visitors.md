# Pricing pages and visitors

## Signed-out pricing

Pricing pages call your server, which reads the pricing with `server.pricing()`. Neither in-app
credential can hold `plans:read`, so the in-app client has no signed-out pricing.

```ts
const pricing = await server.pricing({ visitor });
for (const plan of pricing.plans) console.log(plan.name, plan.periods.map((period) => period.label));
```

Pricing is always computed now, whatever `asOf` says, and goes through the answer cache.

## Visitors

A visitor id keeps a person in the same experiment arm on every page and after they sign up. It
matches `VISITOR_ID_PATTERN` (16 to 64 letters, numbers, hyphens or underscores).

- On a server, the SDK never generates or keeps a visitor, because one server serves many visitors.
  Mint one with `newVisitorId()` (or `server.newVisitorId()`), keep it for the visitor in a
  first-party cookie, and pass it to `server.pricing({ visitor })`, `customer.pricing({ visitor })` and
  `customer.register({ visitor })`.
- In an app, the in-app client sends its visitor on every request. In browsers a generated id is kept
  in `localStorage` under `entitler.visitor`; elsewhere it lives for the client's lifetime. Pass
  `visitor` to use your own.

```ts
import { newVisitorId, VISITOR_ID_PATTERN } from "@entitlerhq/entitler";

const fromCookie = cookies.get("visitor");
const id = fromCookie && VISITOR_ID_PATTERN.test(fromCookie) ? fromCookie : newVisitorId();
await server.customer("user_123").register({ visitor: id });
```

## A signed-in customer's pricing

`customer.pricing()` answers the pricing on sale to that customer, through the cache.

```ts
const offer = await customer.pricing();
console.log(offer.defaultPlan, offer.plans.length);
```

The [pricing-page example](../examples/pricing-page/index.ts) prints a pricing page.
