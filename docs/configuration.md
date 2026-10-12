# Configuration

Both clients take one options object:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://api.entitler.dev` | trailing slashes removed |
| `timeout` | `10_000` | each attempt's deadline, in milliseconds |
| `maxRetries` | `2` | retries after the first attempt |
| `maxRetryDelay` | `10_000` | the longest `Retry-After` the SDK waits for, in milliseconds |
| `cache` | a `MemoryCache` of 1,000 answers | a `MemoryCache` of another size, or `false`; the server client also takes any `CacheStore` |
| `staleFor` | 24 hours | how long a kept answer may stand in while Entitler is unreachable, in milliseconds |
| `onError` | none | called with each error a fallback absorbed, a hold's failed release or disposal, and a custom store's failures; one that throws is ignored |
| `fetch` | the global `fetch` | the transport, for tests, proxies and instrumentation |

The in-app client also takes `visitor` ([visitors](pricing-and-visitors.md)). Neither client takes an
as-of instant: a server customer's reads take `asOf` per call ([as-of](as-of.md)). In-app clients
keep answers in memory only, so they refuse a custom store.

```ts
import { EntitlerServer, MemoryCache } from "@entitlerhq/entitler";

const configured = new EntitlerServer({
  key: process.env.ENTITLER_KEY ?? "",
  baseUrl: "https://api.entitler.dev",
  timeout: 5_000,
  maxRetries: 3,
  cache: new MemoryCache({ maxEntries: 5_000 }),
  fetch: (input, init) => {
    console.debug("Entitler request", init?.method ?? "GET");
    return fetch(input, init);
  },
});
console.log(String(configured));
```

The SDK calls `fetch` as a plain function, never as a method, so a bound or wrapped `fetch` works in
Cloudflare Workers. It sets `User-Agent` outside browsers. A client's string, JSON and
`console.log` forms show only its base URL and kind, never its credential.

Create one server client per process (one per Worker isolate) and share it. Where a build imports the
module without the key, as `next build` does, create it on first use instead of at module scope (see
[Next.js](nextjs.md)). An in-app client is one per signed-in customer, closed at sign-out
([the in-app client](in-app-client.md)). `close()` cancels the calls in flight and drops the in-memory
cache; an injected `fetch` stays as it is.
