# Configuration

Both clients take one options object:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://api.entitler.dev` | trailing slashes removed |
| `timeout` | `10_000` | each attempt's deadline, in milliseconds |
| `maxRetries` | `2` | retries after the first attempt |
| `maxRetryDelay` | `10_000` | the longest `Retry-After` the SDK waits for, in milliseconds |
| `cache` | a `MemoryCache` of 1,000 answers | a `CacheStore`, or `false` |
| `staleFor` | 24 hours | how long a kept answer may stand in while Entitler is unreachable, in milliseconds |
| `onError` | none | called with each error a fallback absorbed |
| `asOf` | none | read the API at another instant ([as-of](as-of.md)) |
| `fetch` | the global `fetch` | the transport, for tests, proxies and instrumentation |

The in-app client also takes `visitor` ([visitors](pricing-and-visitors.md)).

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

Clients own no connection, so they have no `close()`. Create one per process (one per Worker isolate),
at module scope, and share it.
