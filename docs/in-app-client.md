# The in-app client

`EntitlerClient` runs in browsers, mobile and desktop apps. Signed in, it acts on one customer, the
one its credential names, as `client.me`; signed out, it reads pricing with a publishable key.

## Why never a secret key

Anyone can read a key out of a browser bundle or an app binary, and a secret key acts on every
customer in the environment. So the in-app client takes only:

- `{ token }`: a customer token your server minted with `customer.token()`. It names one customer,
  holds only the scopes your server asked for, and lasts at most an hour.
- `{ key, identityToken }`: a publishable key (`ent_pk_…`) and an identity token from a sign-in
  provider registered on the project, sent as `Entitler-Identity-Token`.
- `{ key }`: a publishable key alone, for a signed-out paywall or pricing page, with `pricing()`
  and no `me`.

Publishable keys start `ent_pk_`, and every other key is secret. `EntitlerClient` refuses a secret
key and `EntitlerServer` a publishable one, at construction, so a server key pasted into an app fails
on your machine, never in a shipped app.

## One client per signed-in customer

Create the client when the customer signs in, keep it where the app keeps its session state (owned
by the application, not by one screen), and close it when they sign out. Screens then share one
cache, one token and one visitor, and the next sign-in creates a new client, so nothing kept for one
person is ever answered to another. `close()` cancels every call in flight and the pending token
refresh, and drops the in-memory cache; later calls reject with a `DOMException` named
`InvalidStateError`.

```ts
import { EntitlerClient, resetStoredVisitor } from "@entitlerhq/entitler";

let current: EntitlerClient<"token"> | undefined;

export function onSignIn(): EntitlerClient<"token"> {
  current = new EntitlerClient({
    token: async ({ signal }) => {
      const response = await fetch("/api/entitler-token", { signal, credentials: "include" });
      return ((await response.json()) as { token: string }).token;
    },
  });
  return current;
}

export function onSignOut(): void {
  current?.close();
  current = undefined;
  resetStoredVisitor();
}
```

Its answers live in memory only, so only snapshots survive a relaunch: see
[offline snapshots](offline-snapshots.md).

## Customer tokens from your server

Mint tokens with the fewest scopes. Without `scopes`, a token holds `entitlements:read` alone. Ask for
`usage:write` only when the app records usage itself, and for `billing:self` only for people who may
buy for the customer (a workspace's owners, not every member):

```ts
const issued = await server.customer(session.userId).token({
  scopes: ["entitlements:read", "usage:write"],
  ttlSeconds: 900,
});
console.log(issued.scopes, issued.expiresAt);
```

## Token providers

A provider is called for the first request, again when the kept token expires within 60 seconds
(or half its lifetime, when that is shorter), and once after a `401`, which the request is retried
with; it is asked at most once per request. Concurrent requests share one pending refresh, which
belongs to the client: one caller cancelling stops only its own wait, the provider call has the
client's `timeout` as its deadline, and a failed refresh is not kept, so the next request asks
again. A provider that fails, or answers a blank or unreadable token, fails the call with a
`TokenError` carrying the cause, never the token; the cause is the provider's own error, outside
the SDK's control. A fixed token string cannot be refreshed, so a `401` fails the call. A
`403 credential_not_allowed` means the route refuses that kind of credential, and is never refreshed.

## Identity tokens

```ts
import { EntitlerClient } from "@entitlerhq/entitler";

const signedIn = new EntitlerClient({
  key: "ent_pk_live_…",
  identityToken: async () => auth.currentUser.getIdToken(),
});
await signedIn.register();
```

Call `register()` after each sign-in: an existing customer is answered without being created again.
It answers `403 registration_closed` when the sign-in provider does not let people register
themselves (`scopes()`'s `registration` says so ahead), and `403 scope_required` when the key lacks
`customers:register`. TypeScript refuses `register()` on a token client; plain JavaScript sends it,
and the API refuses it.

Pick a sign-in provider whose identity tokens the device can refresh. Sign in with Apple's identity
tokens last ten minutes and cannot be refreshed on the device, so put a provider that refreshes its
own, such as Firebase Auth, in front of it. An identity-token customer's external id is
`<provider id>:<subject>`, which your server uses to act on them.

## The members

- Token and identity clients: `me` (the `Customer` interface), `scopes()`, `register()` (identity
  only), `snapshotKeys()`, `verifySnapshot()`, `visitor` and `close()`.
- Publishable-key clients: `pricing()`, `snapshotKeys()`, `verifySnapshot()`, `visitor` and
  `close()`.
