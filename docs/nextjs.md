# Next.js

Keep the server client in a server-only module, and use it from route handlers and server components.

```ts
import { EntitlerServer } from "@entitlerhq/entitler";

export const entitler = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
```

## Route handlers

```ts
import { NextResponse } from "next/server";
import { EntitlerServer } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

const entitler = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const result = await entitler.customer(userId).recordUsage(features.aiCredits, 1, {
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    signal: request.signal,
  });
  if (result.outcome === "refused") return NextResponse.json({ error: "Out of credits." }, { status: 402 });
  return NextResponse.json({ remaining: result.remaining });
}
```

## Server components

```ts
import { cookies } from "next/headers";
import { EntitlerServer, newVisitorId } from "@entitlerhq/entitler";

const entitler = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });

export default async function PricingPage() {
  const visitor = (await cookies()).get("visitor")?.value ?? newVisitorId();
  const pricing = await entitler.pricing({ visitor });
  return pricing.plans.map((plan) => plan.name).join(", ");
}
```

Set the visitor cookie in middleware or a route handler, since server components cannot write
cookies. Answers go through the SDK's own cache, so a page that renders often checks Entitler only
when an answer's `max-age` has passed.
