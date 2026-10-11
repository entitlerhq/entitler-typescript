# Cloudflare Workers

Create the client once per isolate, at module scope, so its answer cache serves many requests. Cache
entries are plain data, never `Response` objects, so sharing them between requests is safe. Pass the
request's `signal` so a cancelled request stops its Entitler calls. Take the customer from your app's
authenticated session, never from a header, query string or body the caller controls, and answer
`401` when nobody is signed in; `signedInUserId` stands for that lookup.

```ts
import { defineFeature, EntitlerServer } from "@entitlerhq/entitler";

interface Env {
  ENTITLER_KEY: string;
}

declare function signedInUserId(request: Request, env: Env): Promise<string | undefined>;

const exportPdf = defineFeature("export_pdf", "boolean");
let server: EntitlerServer | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    server ??= new EntitlerServer({ key: env.ENTITLER_KEY });
    const userId = await signedInUserId(request, env);
    if (!userId) return Response.json({ error: "Sign in first." }, { status: 401 });
    const customer = server.customer(userId);
    const allowed = await customer.isEntitled(exportPdf, { default: false, signal: request.signal });
    return allowed ? new Response("%PDF-1.7") : Response.json({ error: "Upgrade first." }, { status: 402 });
  },
};
```

To share answers across isolates, back the cache with Workers KV. `set` receives each entry's
lifetime in milliseconds (`staleFor` plus its `max-age`), so keep the entry that long, and no less
than KV's minimum of 60 seconds:

```ts
import type { CacheEntry, CacheStore } from "@entitlerhq/entitler";

interface Kv {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export function kvCache(kv: Kv): CacheStore {
  return {
    get: async (key) => ((await kv.get(key, "json")) as CacheEntry | null) ?? undefined,
    set: (key, entry, ttl) =>
      kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(ttl / 1000)) }),
  };
}
```

The [cloudflare-worker example](../examples/cloudflare-worker/index.ts) is a complete Worker, with
a signed session cookie as its session.
