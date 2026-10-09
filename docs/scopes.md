# Scopes

Entitler decides what a credential may do, so the SDK never refuses a call itself: it sends the
request, and a missing scope comes back as `403 scope_required`. No request waits on a scope lookup.

`scopes()` tells your app which scopes its client holds, for deciding what to show. Each call asks
again, so a newly granted scope shows without a restart.

```ts
const { scopes } = await server.scopes();
if (scopes.includes("customers:write")) console.log("Show the billing controls.");
```

| Method | Scope |
| --- | --- |
| `check`, `isEntitled`, `entitlements`, `planSpace`, `customer.pricing`, `snapshot` | `entitlements:read` |
| `usage`, `hold` | `usage:read` |
| `recordUsage`, `holdUsage`, `settleUsage`, `releaseUsage`, `withHold`, `recordUsageBatch` | `usage:write` |
| `server.pricing`, `features` | `plans:read` |
| `register` | `customers:register`; changing an existing customer's details needs `customers:write` or `customers:profile` |
| `details`, `customers.list`, `billing`, `providers` | `customers:read` |
| `update` | `customers:write` or `customers:profile` |
| `customers.create`, `delete`, billing changes, `checkout`, `billingPortal`, every `vendor` method | `customers:write` |
| `token` | `tokens:mint` |
| `setTrack` | `tracks:assign` |
| `scopes`, `snapshotKeys`, `verifySnapshot`, `newVisitorId` | none |

`scopes()` answers the scopes the SDK knows, in this order: `plans:read`, `entitlements:read`,
`usage:read`, `usage:write`, `customers:register`, `customers:read`, `customers:write`,
`customers:profile`, `customers:sample`, `tokens:mint`, `plans:write`, `plans:release`,
`tracks:manage`, `tracks:promote`, `tracks:assign`, `keys:manage`, `members:manage`,
`projects:manage`, `org:manage`. For an identity client it also answers `registration`, whether the
sign-in provider lets a new person register.
