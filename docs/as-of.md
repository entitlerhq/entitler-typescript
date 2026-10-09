# As-of reads

`asOf` reads the API at another instant: what a customer was entitled to last Tuesday, or will be
after a booked change. It takes a `Date` or an RFC 3339 string with an offset, and is sent as
`Entitler-As-Of` on every request, in UTC with milliseconds.

```ts
import { EntitlerServer } from "@entitlerhq/entitler";

const lastMonth = new EntitlerServer({
  key: process.env.ENTITLER_KEY ?? "",
  asOf: "2026-09-01T00:00:00+10:00",
});
const then = await lastMonth.customer("user_123").check(features.aiCredits);
console.log(then.asOf.toISOString(), then.used);
```

- Reads at another instant need the organisation's `as_of` capability; without it they answer
  `409 limit_reached`.
- Pricing answers are always computed now.
- Writes take `asOf` only in a test environment.

An invalid instant fails construction with `Pass asOf as a valid date.`
