# Entitler SDK for TypeScript and JavaScript

The official Entitler SDK for TypeScript and JavaScript. Entitler lets SaaS teams manage plans,
feature access, usage limits and customer grants; this SDK checks whether a customer is entitled to a
feature, records metered usage, shows pricing and manages subscriptions, from your servers and from
your apps. It retries, times out, keeps answers within their `max-age` and stands in with the last
known answer when Entitler is unreachable, so a check never takes your app down.

## Requirements and install

Node.js 22 or later, current Bun and Deno, Cloudflare Workers, and evergreen browsers. ESM only, with
no runtime dependencies.

```sh
npm install @entitlerhq/entitler
bun add @entitlerhq/entitler
```

## Quick start

On a server, with a secret key from the dashboard:

```ts
import { defineFeature, EntitlerServer } from "@entitlerhq/entitler";

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  exportPdf: defineFeature("export_pdf", "boolean"),
};

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer("user_123");

await customer.register({ name: "Ada Lovelace", email: "ada@example.com" });

if (await customer.isEntitled(features.exportPdf, { default: false })) {
  console.log("Exporting the PDF.");
}

await customer.recordUsage(features.aiCredits, 3, { idempotencyKey: "job_42" });
```

## Public API

| | |
| --- | --- |
| `new EntitlerServer({ key, ...options })` | `customer(id)`, `customers.list()`, `customers.create()`, `recordUsageBatch()`, `pricing()`, `features()`, `scopes()`, `snapshotKeys()`, `verifySnapshot()`, `newVisitorId()`, `close()` |
| `new EntitlerClient({ token })` or `({ key, identityToken })` | `me`, `register()` (identity clients), `scopes()`, `snapshotKeys()`, `verifySnapshot()`, `visitor`, `close()` |
| `new EntitlerClient({ key })` | `pricing()`, `snapshotKeys()`, `verifySnapshot()`, `visitor`, `close()` |
| `Customer` (`server.customer(id)`, `client.me`) | `check()`, `isEntitled()`, `entitlements()`, `plans()`, `pricing()`, `usage()`, `recordUsage()`, `startHold()`, `withHold()`, `holdUsage()`, `settleUsage()`, `releaseUsage()`, `snapshot()`, `subscribe()`, `cancel()`, `undoPendingChange()`, `billingPortal()`, `syncBilling()` |
| `ServerCustomer` | adds `asOf` on reads, `register()`, `details()`, `update()`, `erase()`, `token()`, `setTrack()`, `billing()`, `setPlan()`, `setAddOn()`, `grant()`, `revokeGrant()`, `adjustMeter()`, `cancelUsage()` |
| Errors | `ApiError`, `ConnectionError`, `TimeoutError`, `TokenError`, `SnapshotError`, `UsageRefusedError`, `UsageReplayedError`, `UsageSettlementError`, all `EntitlerError`; `isUnreachable()` |
| Without a client | `defineFeature()`, `verifySnapshot()`, `newVisitorId()`, `storedVisitorId()`, `resetStoredVisitor()`, `VISITOR_ID_PATTERN`, `MemoryCache` |
| `@entitlerhq/entitler/testing` | `fakeCustomer()`, `answers` |

Every method's last argument is an options object taking `signal` and `timeout`, and on writes
`idempotencyKey`, which usage reports, holds and `adjustMeter` require.

## Two clients

| Client | Built from | Runs | Acts on |
| --- | --- | --- | --- |
| `EntitlerServer` | `{ key }`: a secret project key | your servers | any customer, with `server.customer(id)` |
| `EntitlerClient` | `{ token }`: a customer token your server minted, or `{ key, identityToken }`: a publishable key and a sign-in provider's identity token | browsers, mobile and desktop apps | the signed-in customer, `client.me` |
| `EntitlerClient` | `{ key }`: a publishable key alone | signed-out paywalls and pricing pages | nobody: `pricing()` only |

Both answer the same `Customer` interface, so code that gates features, records usage and offers the
customer's own billing choices is written once:

```ts
import type { Customer } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

export async function exportDocument(customer: Customer, requestId: string): Promise<string> {
  if (!(await customer.isEntitled(features.exportPdf, { default: false }))) return "upgrade";
  await customer.recordUsage(features.aiCredits, 1, { idempotencyKey: `export-${requestId}` });
  return "exported";
}
```

A secret key never goes into an app. Anyone can read a key out of a browser bundle or an app binary,
and a secret key acts on every customer in the environment. The in-app client takes only a customer
token, which names one customer for at most an hour, or a publishable key (`ent_pk_…`) holding
product scopes alone. Each client refuses the other kind of key at construction, so a server key
pasted into an app fails on your machine, never in a shipped app. Keep one in-app client per
signed-in customer and close it at sign-out.

## Feature constants and the generator

Generate typed constants for your catalogue, so checks are typed by the feature's type and a renamed
or archived feature shows up in your editor:

```sh
ENTITLER_KEY=ent_live_… npx @entitlerhq/entitler generate --out src/entitler.gen.ts
npx @entitlerhq/entitler generate --check
```

Generate from the live environment's key, with `plans:read`: a test environment can hold features
that are not released yet. Run `--check` in CI wherever that key is available (pushes to the main
branch, and pull requests from the same repository; forks receive no secrets, so skip it there).
When Entitler lists no features, the generator refuses to empty a file holding constants unless you
pass `--allow-empty`.

`check(features.aiCredits)` then answers a `Check<"metered">` with `used`, `held`, `remaining` and
`resetsAt`, and usage methods accept only metered features. Without the generator, declare constants
with `defineFeature(key, type)`. See [feature constants](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/feature-constants.md). The same tool
writes the snapshot keys an app ships: `npx @entitlerhq/entitler snapshot-keys --out <file>`.

## Guides

- [Checking access](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/checking-access.md): `check`, `isEntitled`, failing open or closed
- [Recording usage](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/recording-usage.md): modes, idempotency keys, `startHold`, `withHold`, batches
- [Pricing pages and visitors](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/pricing-and-visitors.md): publishable keys, visitors through sign-up
- [Billing pages](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/billing.md): `plans()`, `subscribe` and its next step, return URLs, the billing portal
- [Company decisions](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/company-decisions.md): `setPlan`, `setAddOn`, grants, meter adjustments
- [Store purchases](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/store-purchases.md): App Store and Google Play recipes
- [The in-app client](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/in-app-client.md): customer tokens, identity tokens, one client per customer
- [Offline snapshots](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/offline-snapshots.md) and key pinning
- [Reliability](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/reliability.md): timeouts, retries, the cache, stale answers, `onError`
- [Errors](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/errors.md) and their codes
- [As-of reads](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/as-of.md)
- [Tracks](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/tracks.md)
- [Scopes](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/scopes.md)
- [Configuration](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/configuration.md)
- [Feature constants](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/feature-constants.md)
- [Testing your app](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/testing.md): `fakeCustomer` and answer builders
- [Versioning and support](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/versioning.md)
- Frameworks: [Express](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/express.md), [Next.js](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/nextjs.md),
  [Cloudflare Workers](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/cloudflare-workers.md), [React](https://github.com/entitlerhq/entitler-typescript/blob/main/docs/react.md)

## Examples

[quickstart](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/quickstart/index.ts), [pricing-page](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/pricing-page/index.ts),
[in-app](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/in-app/index.ts), [metered-work](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/metered-work/index.ts),
[offline](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/offline/index.ts), [billing](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/billing/index.ts),
[generated-features](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/generated-features/index.ts),
[cloudflare-worker](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/cloudflare-worker/index.ts) and [testing](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/testing/index.ts). The [examples README](https://github.com/entitlerhq/entitler-typescript/blob/main/examples/README.md)
says how to run each one.

## Licence

[MIT](https://github.com/entitlerhq/entitler-typescript/blob/main/LICENSE)
