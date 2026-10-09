# Cloudflare Workers

Create the client once per isolate, at module scope, so its answer cache serves many requests. Cache
entries are plain data, never `Response` objects, so sharing them between requests is safe. Pass the
request's `signal` so a cancelled request stops its Entitler calls.

```ts
import { defineFeature, EntitlerServer } from "@entitlerhq/entitler";

interface Env {
  ENTITLER_KEY: string;
}

const exportPdf = defineFeature("export_pdf", "boolean");
let server: EntitlerServer | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    server ??= new EntitlerServer({ key: env.ENTITLER_KEY });
    const customer = server.customer(request.headers.get("x-user-id") ?? "anonymous");
    const allowed = await customer.isEntitled(exportPdf, { default: false, signal: request.signal });
    return allowed ? new Response("%PDF-1.7") : Response.json({ error: "Upgrade first." }, { status: 402 });
  },
};
```

To share answers across isolates, back the cache with Workers KV:

```ts
import type { CacheEntry, CacheStore } from "@entitlerhq/entitler";

interface Kv {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export function kvCache(kv: Kv): CacheStore {
  return {
    get: async (key) => ((await kv.get(key, "json")) as CacheEntry | null) ?? undefined,
    set: (key, entry) => kv.put(key, JSON.stringify(entry), { expirationTtl: 86_400 }),
  };
}
```

The [cloudflare-worker example](../examples/cloudflare-worker/index.ts) is a complete Worker.
