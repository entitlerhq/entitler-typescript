# Next.js

Keep the server client in a server-only module, created on first use: `next build` imports route
modules without `ENTITLER_KEY`, and a client created at module scope would refuse the blank key during
the build.

```ts
import { EntitlerServer } from "@entitlerhq/entitler";

let client: EntitlerServer | undefined;

export function entitler(): EntitlerServer {
  client ??= new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
  return client;
}
```

## Route handlers

```ts
import { NextResponse } from "next/server";
import { EntitlerServer } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

let client: EntitlerServer | undefined;
const entitler = () => (client ??= new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" }));

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  const requestId = request.headers.get("idempotency-key");
  if (!userId || !requestId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const result = await entitler().customer(userId).recordUsage(features.aiCredits, 1, {
    idempotencyKey: requestId,
    signal: request.signal,
  });
  if (result.outcome === "refused") return NextResponse.json({ error: "Out of credits." }, { status: 402 });
  return NextResponse.json({ remaining: result.remaining });
}
```

## A streamed model answer

Hold an estimate before streaming, so a refusal answers before the stream starts, and finish the hold
however the stream ends, charging for the tokens it used:

```ts
import { EntitlerServer, type Hold, UsageRefusedError } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

let client: EntitlerServer | undefined;
const entitler = () => (client ??= new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" }));

export async function POST(request: Request) {
  const { userId, messageId } = (await request.json()) as { userId: string; messageId: string };
  let hold: Hold;
  try {
    hold = await entitler().customer(userId).startHold(features.aiCredits, 4_000, { idempotencyKey: messageId });
  } catch (error) {
    if (error instanceof UsageRefusedError) return new Response("Out of credits.", { status: 402 });
    throw error;
  }
  hold.use(0);
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const chunk of streamModel({ signal: request.signal })) {
          hold.use(chunk.tokens);
          controller.enqueue(".");
        }
      } finally {
        await hold.finish();
        controller.close();
      }
    },
  });
  return new Response(stream);
}
```

## Server components

```ts
import { cookies } from "next/headers";
import { EntitlerServer, newVisitorId } from "@entitlerhq/entitler";

let client: EntitlerServer | undefined;
const entitler = () => (client ??= new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" }));

export default async function PricingPage() {
  const visitor = (await cookies()).get("visitor")?.value ?? newVisitorId();
  const pricing = await entitler().pricing({ visitor });
  return pricing.plans.map((plan) => plan.name).join(", ");
}
```

Set the visitor cookie in middleware or a route handler, since server components cannot write
cookies. Answers go through the SDK's own cache, so a page that renders often checks Entitler only
when an answer's `max-age` has passed.
