# React

In the browser, use the in-app client with a customer token from your server. Create one client per
signed-in customer when they sign in, keep it beside the app's session state, read through it from
hooks, and close it when they sign out.

```ts
import { useEffect, useState } from "react";
import { EntitlerClient, type Feature, resetStoredVisitor } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

let entitler: EntitlerClient<"token"> | undefined;

export function signIn(): void {
  entitler = new EntitlerClient({
    token: async ({ signal }) => {
      const response = await fetch("/api/entitler-token", { signal, credentials: "include" });
      return ((await response.json()) as { token: string }).token;
    },
  });
}

export function signOut(): void {
  entitler?.close();
  entitler = undefined;
  resetStoredVisitor();
}

export function useEntitled(feature: Feature, fallback = false): boolean | undefined {
  const [entitled, setEntitled] = useState<boolean>();
  useEffect(() => {
    if (!entitler) return undefined;
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
A real app keeps the client in its own session store or context, so components re-render when the
customer signs in or out.
