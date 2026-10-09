# Errors

Every failure the SDK raises is an `EntitlerError`:

| Error | When | Fields |
| --- | --- | --- |
| `ApiError` | Entitler answered with a status other than 2xx, a redirect, or a 2xx this SDK cannot read | `status`, `code`, `message`, `requestId`, `retryAfter` (ms), `idempotencyKey`, `payment`, `listingGaps`, `listingProblems` |
| `ConnectionError` | no answer arrived (DNS, TLS, refused or reset) | `cause`, `idempotencyKey` |
| `TimeoutError` | an attempt passed its `timeout` | `idempotencyKey` |
| `TokenError` | a token provider failed or answered an unusable token | `cause` |
| `SnapshotError` | snapshot verification failed | `code`: `snapshot_invalid` or `snapshot_expired` |
| `UsageRefusedError` | `startHold` or `withHold` found no allowance for the hold | `result`, the refused answer |
| `UsageReplayedError` | `startHold` or `withHold`'s key replays a hold already settled, released or expired | `result`, the replayed answer |
| `UsageSettlementError` | a hold's `finish()`, or `withHold` after the work succeeded, could not settle or record the excess | `holdId`, `amount`, `excess`, `result`, `cause` |

Argument errors are `TypeError` (`RangeError` for a number out of range), never an `ApiError`. A
closed client's calls reject with a `DOMException` named `InvalidStateError`.
`isUnreachable(error)` answers whether a failure means Entitler could not be reached, so an
offline-capable app falls back to its snapshot.
Errors keep their cause for diagnosis, but never a request or headers carrying a credential. A token
provider's own error is kept as it is, so its contents are outside the SDK's control.
Cancelling rejects with the signal's `reason`, never an `EntitlerError`. No error carries a credential.

```ts
import { ApiError, ConnectionError, TimeoutError } from "@entitlerhq/entitler";

try {
  await customer.subscribe("pro", { returnUrl: "https://app.example.com/billing/return" });
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

`ErrorCode` lists every code the API documents, plus the SDK's own: `http_error` for an answer with
no readable error body (and for any redirect, which the SDK never follows), `invalid_response` for a
2xx answer it cannot read (usually a proxy or captive portal), and `connection_failed` and
`timed_out` on batch event results. API messages are written for you, the developer, not for your
customers. Each billing call's codes are in [billing pages](billing.md). New codes from newer API releases still type-check. Among the common ones:

| Code | Meaning |
| --- | --- |
| `customer_not_found` | a write to a customer who is not registered |
| `feature_not_found` | no feature with that key |
| `not_metered` | usage recorded on a feature that is not metered |
| `idempotency_key_required`, `idempotency_mismatch` | a usage write without a key, or a key reused for another request |
| `invalid_occurred_at` | `occurredAt` outside the window Entitler accepts |
| `hold_settled`, `hold_released`, `hold_expired` | a hold that is no longer open |
| `not_self_serve` | a self-serve change the customer may not choose |
| `payment_required` | a declined payment, or a company plan change waiting on one; see `payment` |
| `return_url_required` | a change needs the provider's page and no `returnUrl` was given |
| `billed_elsewhere` | a store purchase for a product Stripe already bills |
| `registration_closed` | the sign-in provider does not let people register themselves |
| `capability_required` | the organisation lacks a capability, such as the customer portal or as-of reads |
| `scope_required` | the credential lacks a scope |
| `credential_not_allowed` | the route refuses that kind of credential |
| `unauthorised` | the credential is not valid now |
| `rate_limited` | too many requests; retried with `Retry-After` |
| `limit_reached` | a limit is used up |
| `stale` | the payment provider is not connected or out of date |
| `provider_partial`, `connection_unreadable` | a payment provider change a retry cannot fix |
