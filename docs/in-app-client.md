# The in-app client

`EntitlerClient` runs in browsers, mobile and desktop apps, and acts on one customer, the one its
credential names, as `client.me`.

## Why never a secret key

Anyone can read a key out of a browser bundle or an app binary, and a secret key acts on every
customer in the environment. So the in-app client takes only:

- `{ token }`: a customer token your server minted with `customer.token()`. It names one customer,
  holds at most `entitlements:read`, `usage:read` and `usage:write`, and lasts at most an hour.
- `{ key, identityToken }`: a publishable key holding product scopes alone, and an identity token from
  a sign-in provider registered on the project, sent as `Entitler-Identity-Token`.

## Customer tokens from your server

```ts
const issued = await server.customer(session.userId).token({ ttlSeconds: 900 });
console.log(issued.token, issued.expiresAt);
```

In the app, pass a token provider that asks your server:

```ts
import { EntitlerClient } from "@entitlerhq/entitler";

const app = new EntitlerClient({
  token: async ({ signal }) => {
    const response = await fetch("/api/entitler-token", { signal, credentials: "include" });
    return ((await response.json()) as { token: string }).token;
  },
});
await app.me.isEntitled(features.exportPdf, { default: false });
```

## Token providers

A provider is called for the first request, again when the kept token expires within 60 seconds, and
once after a `401`, which the request is retried with. Concurrent requests share one pending
refresh. A provider that fails, or answers a blank or unreadable token, fails the call with a
`TokenError` carrying the cause, never the token. A fixed token string cannot be refreshed, so a `401`
fails the call. A `403 credential_not_allowed` means the route refuses that kind of credential, and
is never refreshed.

## Identity tokens

```ts
import { EntitlerClient } from "@entitlerhq/entitler";

const signedIn = new EntitlerClient({
  key: "ent_pub_…",
  identityToken: async () => auth.currentUser.getIdToken(),
});
const scopes = await signedIn.scopes();
if (scopes.registration) await signedIn.register();
```

`register()` exists only on a client built from an identity token, so TypeScript refuses it on a
token client. An identity-token customer's external id is `<provider id>:<subject>`, which your server
uses to act on them.

## What the in-app client offers

`me` (the `Customer` interface), `register()`, `scopes()`, `snapshotKeys()`, `verifySnapshot()` and
`visitor`. It has no signed-out pricing and no `features()`: neither credential can hold
`plans:read`.
