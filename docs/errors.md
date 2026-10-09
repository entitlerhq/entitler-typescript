# Errors

Every failure the SDK raises is an `EntitlerError`:

| Error | When | Fields |
| --- | --- | --- |
| `ApiError` | Entitler answered with a status other than 2xx | `status`, `code`, `message`, `requestId`, `retryAfter` (ms), `idempotencyKey`, `payment`, `listingGaps`, `listingProblems` |
| `ConnectionError` | no answer arrived (DNS, TLS, refused or reset) | `cause`, `idempotencyKey` |
| `TimeoutError` | an attempt passed its `timeout` | `idempotencyKey` |
| `TokenError` | a token provider failed or answered an unusable token | `cause` |
| `SnapshotError` | snapshot verification failed | `code`: `snapshot_invalid` or `snapshot_expired` |
| `UsageRefusedError` | `withHold`'s hold was refused | `result`, the refused answer |
| `SettleError` | `withHold` could not settle after the work succeeded | `holdId`, `amount`, `cause` |

Argument errors are `TypeError` (`RangeError` for a number out of range), never an `ApiError`.
Cancelling rejects with the signal's `reason`, never an `EntitlerError`. No error carries a credential.

```ts
import { ApiError, ConnectionError, TimeoutError } from "@entitlerhq/entitler";

try {
  await customer.subscribe("pro");
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.status, error.code, error.message, error.requestId);
    if (error.code === "payment_required") console.log(error.payment?.status, error.payment?.url);
  } else if (error instanceof ConnectionError || error instanceof TimeoutError) {
    console.error(`Try again later with key ${error.idempotencyKey}.`);
  } else throw error;
}
```

## Codes

`ErrorCode` lists every code the API documents, plus the SDK's own `http_error` for an answer with
no readable error body. New codes from newer API releases still type-check. Among the common ones:

| Code | Meaning |
| --- | --- |
| `customer_not_found` | a write to a customer who is not registered |
| `feature_not_found` | no feature with that key |
| `not_metered` | usage recorded on a feature that is not metered |
| `idempotency_key_required`, `idempotency_mismatch` | a usage write without a key, or a key reused for another request |
| `invalid_occurred_at` | `occurredAt` outside the window Entitler accepts |
| `hold_settled`, `hold_released`, `hold_expired` | a hold that is no longer open |
| `not_self_serve` | a self-serve change the customer may not choose |
| `payment_required` | a plan change waits on a payment; see `payment` |
| `scope_required` | the credential lacks a scope |
| `credential_not_allowed` | the route refuses that kind of credential |
| `unauthorised` | the credential is not valid now |
| `rate_limited` | too many requests; retried with `Retry-After` |
| `limit_reached` | the organisation's plan does not allow it, such as as-of reads |
| `stale` | the payment provider is not connected or out of date |
| `provider_partial`, `connection_unreadable` | a payment provider change a retry cannot fix |
