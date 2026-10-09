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

`verifySnapshot` makes no request. It checks, in order: the token's compact form and header (with no
`crit` member), that one of the
keys passed signed it, the signature, the claims' shape, the issuer (default
`https://api.entitler.dev/customers`), that it was not signed in the future (by more than
`clockSkewSeconds`, default 60, at most 300), that it has not expired, and that it is for the expected
customer and environment. Each failure is a `SnapshotError` with `code` `snapshot_invalid` or
`snapshot_expired`.

## Where `expected` comes from

A mistake here shows only offline. The customer is the signed-in person's external id from the app's
own session, never from the stored snapshot: for an identity-token customer, `<provider id>:<subject>`,
with the sign-in provider's Entitler id from the app's configuration. The environment is the
environment id the app's build ships, beside its snapshot keys.

## Key pinning

The keys decide which snapshots your app trusts. Ship them with the app, written at build time by the
command-line tool, and replace them only with keys fetched from Entitler over HTTPS. Never store them
beside the token or load them from the same record: anyone who can edit that record could replace both.

```sh
npx @entitlerhq/entitler snapshot-keys --out src/entitler-snapshot-keys.json
```

Run it in the app's build (a prebuild script), so key pinning needs no hand-written download. It
needs no key, and refuses to write an empty key set.

## Falling back offline

Snapshots are the only answers that survive a relaunch: the in-app client keeps its other answers in
memory. When a read fails because Entitler is unreachable, fall back to the snapshot:

```ts
import { isUnreachable, verifySnapshot } from "@entitlerhq/entitler";

async function canExport(saved: string): Promise<boolean> {
  try {
    return (await customer.check(features.exportPdf)).entitled;
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    const offline = await verifySnapshot(saved, { keys: shippedKeys, customer: "user_123", environment: "e034…" });
    return offline.entitlements.has(features.exportPdf);
  }
}
```

## Key rotation

- Entitler publishes a new signing key before signing with it.
- It keeps retired keys published for 30 days after their last use, longer than any snapshot lives.
- An emergency replacement withdraws the old keys at once, and snapshots they signed stop verifying
  once the app refetches.

So refresh the keys from `snapshotKeys()` whenever the app is online, persist them in the app's own
trusted storage, and verify offline against the keys it holds. A snapshot signed by a key the app has not
fetched yet fails with `None of the keys passed signed this snapshot.` until the app is next online.
Verification itself never makes a request, and `snapshotKeys()` sends no credential, so the keys stay
reachable even while a token cannot be had.

## Frozen meters

Meters in a snapshot are frozen when it is signed: `used` and `remaining` do not move offline. A
snapshot expires no later than the first time-limited grant it holds ends, or the customer's booked
change takes effect.
