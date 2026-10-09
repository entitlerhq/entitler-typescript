# Express

Create one server client at module scope, and gate routes with a middleware that reads the signed-in
customer from your session.

```ts
import express, { type NextFunction, type Request, type Response } from "express";
import { EntitlerServer, type Feature } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.js";

const entitler = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });

function requires(feature: Feature) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.header("x-user-id");
    if (!userId) return void res.status(401).json({ error: "Sign in first." });
    const allowed = await entitler.customer(userId).isEntitled(feature, { default: false });
    if (!allowed) return void res.status(402).json({ error: `Upgrade to use ${feature.key}.` });
    next();
  };
}

const app = express();

app.post("/export", requires(features.exportPdf), (_req, res) => {
  res.type("application/pdf").send("%PDF-1.7");
});

app.post("/api/entitler-token", async (req, res) => {
  const issued = await entitler.customer(req.header("x-user-id") ?? "").token({ ttlSeconds: 900 });
  res.json({ token: issued.token });
});

app.listen(3000);
```

The token route lets the [in-app client](in-app-client.md) in your front end fetch customer tokens.
