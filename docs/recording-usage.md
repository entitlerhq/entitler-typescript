# Recording usage

Usage is recorded on metered features only (others answer `400 not_metered`), so usage methods take
only a metered feature constant: declare one with `defineFeature("ai_credits", "metered")` when you
do not use the generator. Amounts are whole numbers in the feature's unit, from 1 to 2^53 − 1.

## Idempotency keys from your own work

Every usage write carries an idempotency key, and Entitler keeps it for good. Pass a key derived
from your own unit of work, such as a job id or a message id, so a retry from another process or
after a restart is recognised as the same report. Without one, the SDK generates a key, which only
protects its own retries. Reusing a key for a different request answers `422 idempotency_mismatch`.

```ts
const result = await customer.recordUsage(features.aiCredits, 3, { idempotencyKey: `job-${job.id}` });
console.log(result.outcome);
```

## Modes

- `gate` (the default) records only if the amount fits the allowance; otherwise it records nothing
  and answers `outcome: "refused"` with a `refusal` of `not_entitled` or `over_allowance`. Use it
  before work that must not start without allowance.
- `observe` always records what happened. The meter may pass the allowance, and `overBy` says by how
  much. Use it for work that already happened: streamed tokens, bandwidth, minutes.

```ts
const gated = await customer.recordUsage(features.aiCredits, 50);
if (gated.outcome === "refused") console.log(`Refused: ${gated.refusal}`);

const observed = await customer.recordUsage(features.aiCredits, 1200, { mode: "observe" });
console.log(`Over the allowance by ${observed.overBy}.`);
```

A refusal is an answer, not an error, and a refused report stores no key, so it can be retried with
the same key once there is allowance. A replay of the same key records nothing and answers
`duplicate`.

### When it happened

`occurredAt` counts the usage in the period it happened in. Entitler refuses an instant more than the
project's offline days back, more than 5 minutes ahead, or before the customer registered
(`400 invalid_occurred_at`).

```ts
await customer.recordUsage(features.aiCredits, 2, { mode: "observe", occurredAt: new Date(job.finishedAt) });
```

`register: true` registers a customer not registered yet with the report, if the credential may
register customers.

## Holds

A hold reserves an amount against `remaining` until it is settled, released or expires
(`ttlSeconds` 1 to 3,600, default 300). Settle with the real amount, from 0 to the amount held.

```ts
const hold = await customer.holdUsage(features.aiCredits, 500, { ttlSeconds: 120 });
if (hold.outcome === "held" && hold.holdId) {
  await customer.settleUsage(hold.holdId, 320);
}
```

A hold that was settled, released or expired answers `409 hold_settled`, `hold_released` or
`hold_expired`. Releasing twice is safe, and `hold(holdId)` reads one back.

## `withHold`

`withHold(feature, amount, work)` holds the amount and runs `work`, passing it the hold. `work`
reports the total it really used with `hold.use(n)` (a later call replaces an earlier one) and
returns whatever your app needs, which `withHold` answers. The reported amount is settled, up to the
held amount; when `work` reports none, the held amount is settled. Any excess is recorded in
`observe` mode with the hold's key plus `:excess`.

```ts
import { UsageRefusedError, UsageSettlementError } from "@entitlerhq/entitler";

try {
  const reply = await customer.withHold(
    features.aiCredits,
    500,
    async ({ hold, signal }) => {
      const answer = await run({ signal });
      hold.use(answer.tokens);
      return answer;
    },
    { idempotencyKey: `job-${job.id}` },
  );
  console.log(reply.tokens);
} catch (error) {
  if (error instanceof UsageRefusedError) console.log(`Refused: ${error.result.refusal ?? error.result.outcome}`);
  else if (error instanceof UsageSettlementError) console.log(`Settle ${error.holdId} again later.`, error.result);
  else throw error;
}
```

- `work` runs only when the hold answers `held`, or `duplicate` for a hold still open. A refused
  hold, or a replay of one already settled, released or expired, never runs `work`: the call fails
  with `UsageRefusedError`, carrying the answer.
- When `work` fails, or the call is cancelled while it runs, the hold is released (outside the
  cancelled signal, bounded by the client's timeout) and the error propagates. A failed release
  goes to `onError`, since the hold expires on its own.
- When the hold expired while `work` ran, the whole reported amount is recorded in `observe` mode,
  since the work happened.
- When settling or recording the excess fails, the call fails with `UsageSettlementError`, carrying
  `holdId`, `amount`, `excess` and `work`'s `result`, so you keep the output and can call
  `settleUsage(holdId, amount)` before the hold expires.

`withHold` keeps the accounting exactly once, not `work`: two callers using the same key at the
same time may both run `work`. Where `work` itself must run once, coordinate it yourself. Keep a
`withHold` key to 193 characters or fewer, so the `:excess` key fits in 200.

## The usage log

`usage()` answers each metered feature's meter and the usage log, fetched a page at a time:

```ts
const usage = await customer.usage();
for (const meter of usage.features) console.log(meter.feature, meter.used, meter.remaining);
for await (const event of usage.log) console.log(event.at, event.feature, event.amount);
```

## Batches

On a server, `recordUsageBatch` records many events in `observe` mode, in requests of at most 500
events sent in order. Each event's idempotency key is yours, or a generated one, and each result
carries the key it was sent with. Each request sends its own `Idempotency-Key`: your batch key plus
`:<request index>`, or a new one.

A request that fails after its retries never throws: its events are answered with outcome `error`
and that failure's code and message (`connection_failed` or `timed_out` when no answer arrived),
and the next request still goes. Resend the events answered `error` with the same keys; keys derived
from your own unit of work make any resend safe.

```ts
const batch = await server.recordUsageBatch(
  [
    { customer: "user_1", feature: features.aiCredits, amount: 3, idempotencyKey: "msg-1" },
    { customer: "user_2", feature: features.aiCredits, amount: 1, idempotencyKey: "msg-2" },
  ],
  { idempotencyKey: "import-2026-10-09" },
);
const retry = batch.results.filter((result) => result.outcome === "error").map((result) => result.idempotencyKey);
console.log(batch.recorded, batch.duplicates, batch.errors, retry);
```

## Corrections

The vendor corrects usage with `vendor.cancelUsage(usageId)` and `vendor.setMeter(feature, used)`.
See [billing](billing.md).

Customer and identity tokens may report 100 times every 10 seconds per customer; more answers
`429 rate_limited`, which the SDK retries.
