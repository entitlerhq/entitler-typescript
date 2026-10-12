# Express

Create one server client at module scope, and gate routes with a middleware that reads the signed-in
customer from your session. `signedInUserId` stands for your app's own session lookup (a verified
session cookie or bearer token): never take the customer id from a header, query string or body the
caller controls, or any caller could act as any customer. Express 4 does not catch a rejected
promise, so each async handler passes its errors to `next`.

```ts
import express, { type NextFunction, type Request, type Response } from "express";
import { EntitlerServer, type Feature } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

declare function signedInUserId(req: Request): Promise<string | undefined>;

const entitler = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });

function requires(feature: Feature) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await signedInUserId(req);
      if (!userId) return void res.status(401).json({ error: "Sign in first." });
      const allowed = await entitler.customer(userId).isEntitled(feature, { default: false });
      if (!allowed) return void res.status(402).json({ error: `Upgrade to use ${feature.key}.` });
      next();
    } catch (error) {
      next(error);
    }
  };
}

const app = express();

app.post("/export", requires(features.exportPdf), (_req, res) => {
  res.type("application/pdf").send("%PDF-1.7");
});

app.post("/api/entitler-token", async (req, res, next) => {
  try {
    const userId = await signedInUserId(req);
    if (!userId) return void res.status(401).json({ error: "Sign in first." });
    const issued = await entitler.customer(userId).token({ ttlSeconds: 900 });
    res.json({ token: issued.token });
  } catch (error) {
    next(error);
  }
});

app.listen(3000);
```

The token route lets the [in-app client](in-app-client.md) in your front end fetch customer tokens,
answering `{ "token": "…" }`. It must mint tokens only for the signed-in user, from your session, and
answer `401` to a caller with none: a token acts as its customer, so a route that minted one for any
id it was sent would hand out every customer's access.
