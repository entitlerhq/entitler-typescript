# Offline snapshots

A snapshot is the customer's entitlement list signed by Entitler (ES256), so an app can check
entitlements without a connection until it expires.

```ts
import { verifySnapshot } from "@entitlerhq/entitler";

const snapshot = await customer.snapshot({ ttlSeconds: 86_400 });
const verified = await verifySnapshot(snapshot.token, {
  keys: shippedKeys,
  customer: "user_123",
  environment: "e034…",
});
if (verified.entitlements.has(features.exportPdf)) console.log("Export works offline.");
```

`verifySnapshot` makes no request. It checks, in order: the token's shape and header, that one of the
keys passed signed it, the signature, the claims' shape, the issuer (default
`https://api.entitler.dev/customers`), that it was not signed in the future (by more than
`clockSkewSeconds`, default 60, at most 300), that it has not expired, and that it is for the expected
customer and environment. Each failure is a `SnapshotError` with `code` `snapshot_invalid` or
`snapshot_expired`.

## Key pinning

The keys decide which snapshots your app trusts. Ship them with the app, from `snapshotKeys()` at
build time, and replace them only with keys fetched from Entitler over HTTPS. Never store them beside
the token or load them from the same record: anyone who can edit that record could replace both.

```ts
import { writeFile } from "node:fs/promises";

await writeFile("src/snapshot-keys.json", JSON.stringify(await server.snapshotKeys()));
```

## Frozen meters

Meters in a snapshot are frozen when it is signed: `used` and `remaining` do not move offline. A
snapshot expires no later than the first time-limited grant it holds ends, or the customer's booked
change takes effect.
