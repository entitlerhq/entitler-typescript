# Entitler SDK for TypeScript and JavaScript

The official Entitler SDK for TypeScript and JavaScript. Entitler helps SaaS teams manage plans,
feature access, usage limits and customer grants. This SDK checks whether a customer is entitled to a
feature, records metered usage, shows pricing and moves customers between plans, from your servers
and from your apps. It retries, times out, keeps answers for their `max-age` and stands in with the
last known answer while Entitler is unreachable, and `isEntitled()` falls back to the default you
pass, so an outage never takes your app down.

Learn more at [entitler.co](https://entitler.co).

## Requirements and install

Node.js 22 or later, Bun, and browsers and edge runtimes with `fetch` and WebCrypto. ESM only, with
no runtime dependencies.

```sh
npm install @entitlerhq/entitler
```

## Quick start

On a server, with a secret key from the dashboard:

```ts
import { defineFeature, EntitlerServer } from "@entitlerhq/entitler";

const exportPdf = defineFeature("export_pdf", "switch");
const aiCredits = defineFeature("ai_credits", "metered");

const entitler = new EntitlerServer({ key: process.env.ENTITLER_SECRET_KEY ?? "" });
const customer = entitler.customer("user_123");

await customer.register({ name: "Ada Lovelace", email: "ada@example.com" });

if (await customer.isEntitled(exportPdf, { default: false })) {
  console.log("Exporting the PDF.");
}

const documentId = "doc_42";
const result = await customer.recordUsage(aiCredits, 3, { idempotencyKey: `summary-${documentId}` });
if (result.outcome === "refused") console.log("Out of AI credits:", result.upgrades);
```

## Three clients

| Client | Built from | Runs | Acts on |
| --- | --- | --- | --- |
| `EntitlerServer` | `{ key }`: a secret key | your servers | any customer, with `entitler.customer(id)` |
| `EntitlerClient` | `{ token }`: a customer token your server minted, or `{ key, identityToken }`: a publishable key and a sign-in provider's identity token | browsers, mobile and desktop apps | the signed-in customer, `entitler.me` |
| `EntitlerVisitor` | `{ key }`: a publishable key | signed-out pricing pages | nobody: `pricing()`, `features()` and `snapshotKeys()` |

A secret key never goes into an app: anyone can read it out of a browser bundle or an app binary, and
it acts on every customer in the environment. Mint a customer token on your server with
`entitler.customer(id).token()` and hand it to your own signed-in app.

The server's customer and the in-app client's `me` answer the same `Customer` interface, so code that
gates features, records usage and offers the customer's own billing choices is written once.

## Checking access

```ts
const check = await customer.check(aiCredits);
if (!check.entitled) showUpgrade(check.upgrades);
console.log(check.meter.remaining);
```

`check()` answers Entitler's decision, the value, the meter for a metered feature, where the value
comes from, and the plans that would give it. `entitlements()` lists every entitlement at once.
`isEntitled(feature, { default })` never throws for a failed request: pass `default: false` for paid
features, so they fail closed. Declare features with `defineFeature(key, type)`, so `check` answers
the type the feature has.

Amounts are whole numbers of the feature's smallest unit. `decimals` gives the scale, and a money
feature answers its `currency` and its limits by market in `markets`.

## Recording usage

```ts
const result = await customer.recordUsage(aiCredits, 1, { idempotencyKey: job.id });
if (result.outcome === "refused") showUpgrade(result.upgrades);
```

Every usage write takes an idempotency key from your own unit of work, so a retry from another process
or after a restart never charges twice. `gate` mode, the default, refuses what doesn't fit; `observe`
records everything and says how far past the allowance it went.

For work whose cost is known only at the end, hold an amount first:

```ts
const reply = await customer.withHold(aiCredits, 2_000, async ({ hold, signal }) => {
  if (hold.duplicate) return await replyFor(message.id);
  hold.use(0);
  for await (const chunk of stream(signal)) hold.use(chunk.totalTokens);
  return text;
}, { idempotencyKey: message.id });
```

`withHold` settles what the work reported with `hold.use()`, even when the work throws, and frees the
hold when it reported nothing. It throws `UsageRefusedError` before the work runs when too little is
left. When another caller already holds the same key, `hold.duplicate` is true and that caller
settles, so return its result rather than run the work again. `startHold` gives you the hold to
finish yourself, and `cancelUsage(usageId)` corrects a report.

## Pricing and billing pages

```ts
const visitor = new EntitlerVisitor({ key: "pk_live_…" });
const sheet = await visitor.pricing({ country: "AU", locale: navigator.language });
```

`pricing()` answers the plans on sale, with prices formatted for the locale. A signed-in customer's
`pricing()` adds what they pay now. `plans()` answers the plans the customer can move to, what each
would change, and what they hold: a lane per product with its plan, add-ons, renewal and booked
changes.

```ts
const step = await entitler.me.subscribe("pro", { returnUrl: location.href });
if (step.next === "pay") location.assign(step.url);
```

Every move answers its next step: `done` with what changed, `pay` with the payment page's `url`, or
`confirming` while the payment provider confirms it. When the customer comes back, call
`syncBilling()` and read `plans()` again; when the sync fails or the plan isn't there yet, show the
payment as pending. `cancel()` and `undoPendingChange()` are the customer's own
choices, and `billingPortal({ returnUrl })` opens the provider's page for payment details and invoices.
In an app these need a customer token with the `billing:self` scope.

## Company decisions

On the server, a customer also takes the company's own decisions:

- `setPlan(plan)` moves them to any plan, sales-led ones included.
- `setPlan(null, { product })` ends their plan in a product.
- `setAddOn()`, `removeAddOn()` and `undoAddOnChange()` manage their add-ons.
- `grant()` gives a feature value outside their plans, and `revokeGrant()` ends it.
- `adjustMeter()` sets a meter or moves it.
- `setTrack()` moves them to a track.
- `billing()` reads the payment provider's view, for support tools.

`grant()`, `revokeGrant()` and the plan and add-on moves can pass the customer's `expectedRevision`,
so they fail rather than overwrite a change made since it was read.

## Offline snapshots

An app that must keep working offline asks for a signed snapshot, stores it, and verifies it with
keys it ships:

```ts
const { token } = await entitler.me.snapshot({ ttlSeconds: 86_400 });
const snapshot = await verifySnapshot(token, { keys, customer: session.userId, environment: ENVIRONMENT_ID });
if (snapshot.entitlements.has("export_pdf")) showExport();
```

Fetch the keys once with `snapshotKeys()`, which sends no credential. `verifySnapshot` makes no
request and throws `SnapshotError` with `SNAPSHOT_INVALID` or `SNAPSHOT_EXPIRED`.

## Reliability and errors

Each attempt times out after 10 seconds. Idempotent requests retry twice on connection failures,
timeouts, `408`, `429`, `500`, `502`, `503` and `504`, waiting for `Retry-After`. Reads are kept for their `max-age`, and a kept
answer stands in for up to 24 hours while Entitler is unreachable, marked `stale`. A write for a
customer drops their kept answers for every client using the same key, across processes when the
cache is shared. Pass `timeout`,
`maxRetries`, `staleFor`, `onError` or your own `fetch` when building a client, and `signal` or
`timeout` on any call.

Every error a request raises is an `EntitlerError`; a bad argument throws `TypeError` or
`RangeError` before anything is sent. `ApiError` carries the API's `status`, `code`, `reason` and
`parameters`; `ConnectionError` and `TimeoutError` mean Entitler could not be asked, and
`isUnreachable(error)` tells them apart from a refusal.

## Testing your app

```ts
import { fakeCustomer } from "@entitlerhq/entitler/testing";

const customer = fakeCustomer({ export_pdf: true, ai_credits: { value: 100, used: 90 } });
const result = await customer.recordUsage(aiCredits, 25, { idempotencyKey: "job-1" }); // outcome "refused"
customer.answer("plans", async () => myPlans);
console.log(customer.writes);
```

`fakeCustomer` makes no request. Checks, usage reports, holds and cancelled usage behave as against
Entitler; `answer()` gives any other method's answer, and `writes` lists every write received.

## Examples

[quickstart](examples/quickstart/index.ts), [metered-work](examples/metered-work/index.ts),
[in-app](examples/in-app/index.ts), [pricing-page](examples/pricing-page/index.ts),
[billing](examples/billing/index.ts), [offline](examples/offline/index.ts) and
[testing](examples/testing/index.ts). The type checks cover them, so they stay current.

## Licence

[MIT](LICENSE)
