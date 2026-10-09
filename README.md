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
| `new EntitlerServer({ key, ...options })` | `customer(id)`, `customers.list()`, `customers.create()`, `recordUsageBatch()`, `pricing()`, `features()`, `scopes()`, `snapshotKeys()`, `verifySnapshot()`, `newVisitorId()` |
| `new EntitlerClient({ token })` or `({ key, identityToken })` | `me`, `register()` (identity clients), `scopes()`, `snapshotKeys()`, `verifySnapshot()`, `visitor` |
| `Customer` (`server.customer(id)`, `client.me`) | `check()`, `isEntitled()`, `entitlements()`, `plans()`, `pricing()`, `usage()`, `recordUsage()`, `holdUsage()`, `settleUsage()`, `releaseUsage()`, `hold()`, `withHold()`, `snapshot()` |
| `ServerCustomer` | adds `register()`, `details()`, `update()`, `delete()`, `token()`, `setTrack()`, the self-serve billing calls, and `vendor.*` |
| Errors | `ApiError`, `ConnectionError`, `TimeoutError`, `TokenError`, `SnapshotError`, `UsageRefusedError`, `UsageSettlementError`, all `EntitlerError` |
| Without a client | `defineFeature()`, `verifySnapshot()`, `newVisitorId()`, `VISITOR_ID_PATTERN`, `MemoryCache` |

Every method's last argument is an options object taking `signal` and `timeout`, and on writes
`idempotencyKey`.

## Two clients

| Client | Built from | Runs | Acts on |
| --- | --- | --- | --- |
| `EntitlerServer` | `{ key }`: a secret project key | your servers | any customer, with `server.customer(id)` |
| `EntitlerClient` | `{ token }`: a customer token your server minted, or `{ key, identityToken }`: a publishable key and a sign-in provider's identity token | browsers, mobile and desktop apps | the signed-in customer, `client.me` |

Both answer the same `Customer` interface, so code that gates features and records usage is written
once:

```ts
import type { Customer } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

export async function exportDocument(customer: Customer): Promise<string> {
  if (!(await customer.isEntitled(features.exportPdf, { default: false }))) return "upgrade";
  await customer.recordUsage(features.aiCredits, 1);
  return "exported";
}
```

A secret key never goes into an app. Anyone can read a key out of a browser bundle or an app binary,
and a secret key acts on every customer in the environment. The in-app client takes only a customer
token, which names one customer for at most an hour, or a publishable key holding product scopes
alone, with an identity token that names the signed-in person.

## Feature constants and the generator

Generate typed constants for your catalogue, so checks are typed by the feature's type and a renamed
or archived feature shows up in your editor:

```sh
ENTITLER_KEY=ent_test_… npx @entitlerhq/entitler generate --out src/entitler.gen.ts
npx @entitlerhq/entitler generate --check
```

`check(features.aiCredits)` then answers a `Check<"metered">` with `used`, `held`, `remaining` and
`resetsAt`, and usage methods accept only metered features. Without the generator, declare constants
with `defineFeature(key, type)`. See [feature constants](docs/feature-constants.md).

## Guides

- [Checking access](docs/checking-access.md): `check`, `isEntitled`, failing open or closed
- [Recording usage](docs/recording-usage.md): modes, holds, `withHold`, idempotency keys
- [Pricing pages and visitors](docs/pricing-and-visitors.md)
- [Changing plans](docs/changing-plans.md): `plans()`, upgrades and downgrades
- [Billing](docs/billing.md): self-serve changes, checkout, the billing portal, vendor actions
- [The in-app client](docs/in-app-client.md): customer tokens, identity tokens, token providers
- [Offline snapshots](docs/offline-snapshots.md) and key pinning
- [Reliability](docs/reliability.md): timeouts, retries, the cache, stale answers, `onError`
- [Errors](docs/errors.md) and their codes
- [As-of reads](docs/as-of.md)
- [Tracks](docs/tracks.md)
- [Scopes](docs/scopes.md)
- [Configuration](docs/configuration.md)
- [Feature constants](docs/feature-constants.md)
- [Versioning and support](docs/versioning.md)
- Frameworks: [Express](docs/express.md), [Next.js](docs/nextjs.md),
  [Cloudflare Workers](docs/cloudflare-workers.md), [React](docs/react.md)

## Examples

[quickstart](examples/quickstart/index.ts), [pricing-page](examples/pricing-page/index.ts),
[in-app](examples/in-app/index.ts), [metered-work](examples/metered-work/index.ts),
[offline](examples/offline/index.ts), [billing](examples/billing/index.ts),
[generated-features](examples/generated-features/index.ts) and
[cloudflare-worker](examples/cloudflare-worker/index.ts). The [examples README](examples/README.md)
says how to run each one.

## Licence

[MIT](LICENSE)
