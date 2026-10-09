# Reliability

## Timeouts and cancellation

Each attempt has a deadline, the client's `timeout` (10,000 ms by default), covering the whole
attempt from connecting to the last byte of the answer. Each attempt's signal is
`AbortSignal.any([signal, AbortSignal.timeout(timeout)])`, so a custom `fetch` receives it too. A
passed deadline becomes a `TimeoutError`. Every method takes `signal` and `timeout`:

```ts
const controller = new AbortController();
const check = await customer.check(features.exportPdf, { signal: controller.signal, timeout: 2_000 });
console.log(check.entitled);
```

Aborting rejects with the signal's `reason` (the platform's `AbortError`), unwrapped, also from a
wait between retries.

## Retries

Connection failures, timeouts, and answers `408`, `429`, `500`, `502`, `503` and `504` are retried,
for every request: reads are safe, and every write carries an idempotency key Entitler honours.
Nothing else is retried.

- With `Retry-After` (seconds or an HTTP date), the SDK waits that long. When it asks for longer than
  `maxRetryDelay` (10,000 ms by default), the call fails at once with that answer's `ApiError`, whose
  `retryAfter` says when to try again.
- Otherwise it waits a random time between 0 and `min(8, 0.5 × 2^n)` seconds before retry `n`.
- At most `maxRetries` retries (2 by default), then the last error.

Every write sends `Idempotency-Key`: yours (`idempotencyKey`) or a new UUID, the same on every
attempt. A failed call's error carries the key it sent, so you can repeat the call later with it.

## The answer cache

Checks, entitlement lists, plan space and customer pricing, and on the server `pricing()` and
`features()`, go through the cache: an in-memory store of 1,000 answers by default.

- An answer younger than its `max-age` answers without a request, unless this client has written to
  that customer since, in which case it is revalidated.
- Otherwise the SDK sends `If-None-Match`; a `304` answers the kept copy.
- `no-store` answers are never kept, and answers from the cache are copies.

Pass your own store to share answers between processes, or `cache: false` to turn it off:

```ts
import { type CacheEntry, type CacheStore, EntitlerServer } from "@entitlerhq/entitler";

const kept = new Map<string, CacheEntry>();
const store: CacheStore = {
  get: (key) => kept.get(key),
  set: (key, entry) => {
    kept.set(key, entry);
  },
};
const shared = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "", cache: store });
console.log(shared);
```

Entries are plain JSON-ready data (the body text, `etag`, `maxAge`, `receivedAt`), so Workers KV or
Redis fit, and keys are SHA-256 hashes that never contain a credential.

## Stale answers

When a read through the cache fails because Entitler is unreachable (a connection failure, a timeout,
`429` or a `5xx`, after retries) and the cache holds an answer received less than `staleFor` ago
(24 hours by default), the read answers it with `stale: true` and calls `onError`. Every other
failure throws as usual.

```ts
import { EntitlerServer } from "@entitlerhq/entitler";

const resilient = new EntitlerServer({
  key: process.env.ENTITLER_KEY ?? "",
  staleFor: 6 * 60 * 60 * 1000,
  onError: (error) => console.warn("Entitler fallback", error),
});
console.log(resilient);
```

`onError` is called with each error a fallback absorbed: a stale answer, an `isEntitled` default, and
a hold `withHold` could not release.
