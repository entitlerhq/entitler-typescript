# React

In the browser, use the in-app client with a customer token from your server. Create it once, outside
components, and read through it from a hook.

```ts
import { useEffect, useState } from "react";
import { EntitlerClient, type Feature } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

export const entitler = new EntitlerClient({
  token: async ({ signal }) => {
    const response = await fetch("/api/entitler-token", { signal, credentials: "include" });
    return ((await response.json()) as { token: string }).token;
  },
});

export function useEntitled(feature: Feature, fallback = false): boolean | undefined {
  const [entitled, setEntitled] = useState<boolean>();
  useEffect(() => {
    const controller = new AbortController();
    entitler.me
      .isEntitled(feature, { default: fallback, signal: controller.signal })
      .then(setEntitled, () => undefined);
    return () => controller.abort();
  }, [feature, fallback]);
  return entitled;
}

export function useExportAllowed(): boolean | undefined {
  return useEntitled(features.exportPdf);
}
```

A component then renders `useExportAllowed() ? <ExportButton /> : <UpgradePrompt />`. The client keeps
answers within their `max-age`, so many components asking about the same feature cost one request.
