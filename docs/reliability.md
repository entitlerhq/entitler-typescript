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
- At most `maxRetries` retries (2 by default), then the last error. The one retry with a refreshed
  token after a `401` does not count towards them.
- An answer cut off while it is being read is a `ConnectionError`, and retried like one.

Every write sends `Idempotency-Key`: yours (`idempotencyKey`) or a new UUID, the same on every
attempt. A failed call's error carries the key it sent, so you can repeat the call later with it.

## The answer cache

Checks, entitlement lists, the customer's plans and customer pricing, the server's `pricing()` and
`features()`, and a publishable client's `pricing()`, go through the cache: an in-memory store of 1,000 answers by default. It is the
only cache: requests pass `cache: "no-store"` to `fetch`, so no browser or runtime HTTP cache
answers in its place.

- An answer is fresh while its age (the time since it arrived plus its `Age` header) is below its
  `max-age` and it has no `no-cache`; a fresh answer answers without a request, unless the read
  passes `revalidate: true`, which revalidates it with its `ETag` so a page that knows the customer
  just changed (back from paying, after a server-side upgrade) shows the change at once.
- Every write to a customer (except `token`, `snapshot` and `billingPortal`, which
  change no answer) bumps that customer's write generation first, whether or not it succeeds.
  Answers kept before the bump are revalidated, and a read that was under way during a write is
  never kept as fresh.
- Otherwise the SDK sends `If-None-Match`; a `304` answers the kept copy and renews it, keeping any
  header the `304` leaves out.
- `no-store` answers are never kept, and answers from the cache are copies.

Keys are SHA-256 hashes of the request and a fingerprint of the credential itself, never of token
claims, so a forged token can never read another customer's answers from a shared store. A refreshed
token starts its own entries.

On the server, pass your own store to share answers between processes, or `cache: false` to turn it
off. In-app clients take only a `MemoryCache` size or `false`: their principal changes with every
token, so a store kept across launches would never be read again, and only snapshots survive a
relaunch.

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

Entries are plain JSON-ready data (`v`, the body text, `etag`, `cacheControl`, `age`, `receivedAt`),
so Workers KV or Redis fit. `set` receives a lifetime in milliseconds (`staleFor` plus the entry's
`max-age`); stores that cannot expire entries should drop them after that time. A `get` that fails
counts as a miss and a `set` that fails is skipped; both go to `onError`, and neither fails the call.
Entries are private to this SDK: do not share a store with the SDKs for other languages.

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

After a read fails because Entitler is unreachable, reads with a kept answer answer it, stale, without
a request for the next 30 seconds (or the failed answer's `Retry-After`, if longer); then one request
goes through to test the API. So an outage costs one slow read, not one per call. A 2xx answer the SDK
cannot read counts as unreachable, since its usual cause is a proxy or captive portal.

Stale answers never cross credentials, a token this same client held before included. So when the
token provider fails (offline, typically), the read fails with its `TokenError`, and `isEntitled`
answers its default. Apps that must work offline verify a [snapshot](offline-snapshots.md), falling
back when `isUnreachable(error)` is true.

`onError` is called with each error a fallback absorbed: a stale answer, an `isEntitled` default, a
hold's failed release or disposal, and a custom store's failures. An `onError` that throws is caught
and ignored, so it can never change a call's answer or error.

## Redirects

The SDK never follows a redirect: every request passes `redirect: "manual"`, and any `3xx` other
than `304` fails with an `ApiError` of code `http_error`. So no credential, and above all no
identity token, ever reaches another origin.
