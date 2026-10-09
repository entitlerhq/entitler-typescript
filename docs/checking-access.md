# Checking access

Every check asks Entitler, which decides whether the customer is entitled. The SDK never re-derives
the decision from a value.

## `check`

`check(feature)` answers the full check: `entitled`, the `value`, where it comes from (`sources`),
the plan moves that would give the feature (`upgrades`), and the context (`environment`, `track`,
`release`, `change`, `testers`, `experiment`, `asOf`). A feature constant types the answer:

```ts
import { features } from "./entitler.gen.js";

const credits = await customer.check(features.aiCredits);
console.log(credits.used, credits.held, credits.remaining, credits.resetsAt);

const pdf = await customer.check(features.exportPdf);
if (pdf.value === true) console.log("On");

const general = await customer.check("support_sla_hours");
console.log(general.value);
```

A feature's `value` is `true` (on), a whole number (`0` included), or `"unlimited"`. Checks go
through the answer cache (see [reliability](reliability.md)) and carry `stale: true` only when the SDK
answered from a kept copy because Entitler was unreachable.

## `isEntitled`

`isEntitled(feature, { default })` answers a boolean and never fails because of Entitler: when the
check fails for any reason, it answers `default` and passes the error to the client's `onError`. A
blank feature is still an argument error, and cancelling the call with its `signal` still rejects.

```ts
if (await customer.isEntitled(features.exportPdf, { default: false })) {
  console.log("Show the export button.");
}
```

### Failing open or closed

`default` is required, so the choice reads at the call site:

- `isEntitled(feature, { default: false })` fails closed. Use it for paid features: an outage never
  gives a paid feature away.
- `isEntitled(feature, { default: true })` fails open. Use it only where losing a sale, or blocking
  a customer mid-task, is worse than giving the feature away for a while.

## The entitlement list

`entitlements()` answers every entitlement, groups included, each with Entitler's decision:

```ts
const entitlements = await customer.entitlements();
if (entitlements.has(features.collaboration)) console.log("Show sharing.");
const seats = entitlements.get(features.teamSeats)?.value;
for (const entitlement of entitlements) console.log(entitlement.key, entitlement.entitled);
console.log(seats);
```

`has(feature)` answers the item's `entitled`, and `false` when the list does not hold the feature.
A group is in the list with the server's decision, so `has` never expands one itself.

## Customers not registered yet

A customer who is not registered yet is answered from the default plan by every read, so you can
check before `register()`. Writes to one answer `404 customer_not_found`, except `recordUsage`,
`subscribe` and `setPlan` given `register: true`, which register the customer first when the
credential may register customers.

## Showing a change at once

Reads keep answers within their `max-age`. A page that knows the customer just changed (back from
paying, after a server-side upgrade) passes `revalidate: true`, which skips the fresh kept answer and
revalidates it with its `ETag`; a `304` still answers the kept body:

```ts
const fresh = await customer.check(features.exportPdf, { revalidate: true });
console.log(fresh.entitled, fresh.upgrades.map((upgrade) => `${upgrade.move} to ${upgrade.name} (${upgrade.action})`));
```

A check's `upgrades` lists the plans that would entitle the customer, filled only when they are not
entitled, with the same `move` and `action` as [billing pages](billing.md) use.
