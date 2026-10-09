# As-of reads

A server customer's reads that the API answers at an instant (`check`, `isEntitled`,
`entitlements`, `plans`, `usage` and `details`) take `asOf`: what a customer was entitled to last
Tuesday, or will be after a booked change. It takes a `Date` or an RFC 3339 string with an offset,
and is sent as `Entitler-As-Of` on that request only, in UTC with milliseconds.

```ts
const then = await customer.check(features.aiCredits, { asOf: "2026-09-01T00:00:00+10:00" });
console.log(then.asOf.toISOString(), then.used);
```

- Reads at another instant need the organisation's `as_of` capability; without it they answer
  `409 capability_required`.
- Nothing else sends it: not the in-app client, not pricing, which is always computed now, and never
  a write, so a preview can never change a live environment.
- As-of shows the effects of time on the plans, grants and meters already in place (renewals, booked
  moves, grant expiries, meter resets), never a release nobody has rolled out yet, since nothing is
  derived on a schedule. To preview an unreleased change, put a test customer on a track for testers.
- A read at another instant goes through the answer cache under its own key.

An invalid instant fails the call before any request with `Pass asOf as a valid date.`
