# Recording usage

Usage is recorded on metered features only (others answer `400 not_metered`), so usage methods take
only a metered feature constant: declare one with `defineFeature("ai_credits", "metered")` when you
do not use the generator. Amounts are whole numbers in the feature's unit, from 1 to 2^53 − 1.

## Idempotency keys name the event

Every report and hold carries your own idempotency key, and the SDK never makes one up: a generated
key protects only its own retries, so a retry from the browser, another process or a restart would
charge twice. Entitler keeps the key per customer for good, so it names an event (this message, this
export request, this webhook delivery), never an object whose state changes (a document, a deal): a
key reused after the object changes replays the first answer and records nothing. Reusing a key for
a different request answers `422 idempotency_mismatch`.

```ts
const result = await customer.recordUsage(features.aiCredits, 3, { idempotencyKey: `job-${job.id}` });
console.log(result.outcome, result.replayed);
```

`replayed` is true when the API answered the key with the first call's answer, so this call changed
nothing.

## Modes

- `gate` (the default) records only if the amount fits the allowance; otherwise it records nothing
  and answers `outcome: "refused"` with a `refusal` of `not_entitled` or `over_allowance`. Use it
  before work that must not start without allowance.
- `observe` always records the amount used. The meter may pass the allowance, and `overBy` says by
  how much. Use it for work that already happened: streamed tokens, bandwidth, minutes.

```ts
const gated = await customer.recordUsage(features.aiCredits, 50, { idempotencyKey: `export-${job.id}` });
if (gated.outcome === "refused") console.log(`Refused: ${gated.refusal}`);

const observed = await customer.recordUsage(features.aiCredits, 1200, {
  mode: "observe",
  idempotencyKey: `stream-${job.id}`,
});
console.log(`Over the allowance by ${observed.overBy}.`);
```

A refusal is an answer, not an error, and a refused report stores no key, so it can be retried with
the same key once there is allowance. A replay of the same key records nothing and answers
`duplicate`.

`occurredAt` counts the usage in the period it happened in. Entitler refuses an instant more than the
project's offline days back, more than 5 minutes ahead, or before the customer registered
(`400 invalid_occurred_at`). `register: true` registers a customer not registered yet with the
report, if the credential may register customers.

```ts
await customer.recordUsage(features.aiCredits, 2, {
  mode: "observe",
  occurredAt: new Date(job.finishedAt),
  idempotencyKey: `job-${job.id}`,
});
```

## Streamed work: `startHold`

A streamed model answer needs allowance before it starts and charges for what it used however it
ends. `startHold` holds an estimate before any work, so a route can answer a refusal before it
streams, and answers a `Hold`:

```ts
import { UsageRefusedError, UsageReplayedError } from "@entitlerhq/entitler";

async function streamReply(messageId: string, chunks: AsyncIterable<{ totalTokens: number }>) {
  let hold: Awaited<ReturnType<typeof customer.startHold>>;
  try {
    hold = await customer.startHold(features.aiCredits, 2_000, { idempotencyKey: messageId });
  } catch (error) {
    if (error instanceof UsageRefusedError) return "Upgrade for more credits.";
    if (error instanceof UsageReplayedError) return "This message was already answered.";
    throw error;
  }
  try {
    hold.use(0);
    for await (const chunk of chunks) hold.use(chunk.totalTokens);
    return "Done.";
  } finally {
    await hold.finish();
  }
}
```

- `hold.use(n)` reports the total used so far, with no request; a later call replaces an earlier
  one. Call `use(0)` before a stream starts, so finishing after a failure that used nothing frees the
  whole hold.
- `hold.finish()` ends the work however it ended. It settles the amount reported (the held amount
  when none was), up to the held amount, and records any excess in `observe` mode under the hold's
  key plus `:excess`. When the hold expired first, the whole reported amount goes there, since the
  work happened. So a disconnect after 3,000 tokens charges for 3,000 tokens.
- `hold.release()` frees the hold, recording nothing, for work that never ran.
- `await using hold = await customer.startHold(…)` cleans up on every exit: when neither `finish()`
  nor `release()` ran, it settles the amount reported, else releases, and sends a failure to
  `onError` instead of throwing.
- Only the first of `finish`, `release` and disposal acts; a later call answers the first one's
  result. Each runs with its own timeout, never the caller's signal, so work cancelled halfway still
  settles.
- `hold.duplicate` is true when another caller holds the same key and may be doing the same work,
  so the app can wait for that caller's result instead of paying for the work twice.

A refused hold throws `UsageRefusedError`: the customer has no allowance. A key that replays a hold
already settled, released or expired throws `UsageReplayedError`: the work this key stands for
already happened, so show its result, never an upgrade prompt. When `finish()` cannot settle, it
throws `UsageSettlementError` with `holdId`, `amount` and `excess`: keep the output, call
`settleUsage(holdId, amount)` before the hold expires, and record the excess under the same
`:excess` key. Keys for holds are at most 193 characters, so the `:excess` key fits in 200.

While work runs, `remaining` drops by the whole hold and rises again when it settles, so a live
meter shows `held` apart.

## Work inside one call: `withHold`

`withHold` wraps `startHold` for work whose cost is known only once it returns:

```ts
import { UsageSettlementError } from "@entitlerhq/entitler";

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
  if (error instanceof UsageSettlementError) console.log(`Settle ${error.holdId} again later.`, error.result);
  else throw error;
}
```

When `work` succeeds, `withHold` finishes the hold and answers `work`'s result. When `work` fails, or
the call is cancelled, it disposes of the hold (settling the amount `work` reported, else releasing)
and rethrows. A failed settlement throws `UsageSettlementError` holding `work`'s result.
`withHold` keeps the accounting exactly once, not `work`: `work` reads `hold.duplicate` to learn that
another caller is already doing it. Where `work` itself must run once, coordinate it yourself.

## Holds settled elsewhere

`holdUsage`, `settleUsage` and `releaseUsage` are the raw calls, for a hold settled from another
process. A hold counts against `remaining` until it is settled, released or expires (`ttlSeconds` 1 to
3,600, default 300). A hold that was settled, released or expired answers `409 hold_settled`,
`hold_released` or `hold_expired`. Releasing twice is safe.

## The usage log

`usage()` answers each metered feature's meter and the usage log, fetched a page at a time:

```ts
const usage = await customer.usage();
for (const meter of usage.features) console.log(meter.feature, meter.used, meter.held, meter.remaining);
for await (const item of usage.log) console.log(item.at, item.feature, item.amount);
```

## Batches

On a server, `recordUsageBatch` records many events in `observe` mode, each under its own required
idempotency key, in requests of at most 500 events sent in order. The call takes no key: each
request's key derives from its events, so resending the same events replays the first answer, and
rerunning only the events answered `error` sends a new key.

An event the SDK refuses itself (a blank customer, an amount out of range, a missing key) is
answered `error` with the API's own code and is not sent; the rest still go. A request that fails
after its retries answers its events `error`, with that failure's code (`connection_failed` or
`timed_out` when no answer arrived), and the next request still goes. Only cancellation rejects.

```ts
const batch = await server.recordUsageBatch([
  { customer: "user_1", feature: features.aiCredits, amount: 3, idempotencyKey: "msg-1" },
  { customer: "user_2", feature: features.aiCredits, amount: 1, idempotencyKey: "msg-2" },
]);
const resend = batch.results.filter((result) => result.outcome === "error");
console.log(batch.recorded, batch.duplicates, batch.errors, resend.length);
```

## Corrections

Your team corrects usage with `cancelUsage(usageId)` and `adjustMeter(feature, { by })`. See
[company decisions](company-decisions.md).

## Reports from apps

Reports and holds sent with customer and identity tokens count towards 100 every 10 seconds per
customer, shared by all of that customer's devices (`429 rate_limited`, which the SDK retries);
settlements and releases do not count. Counting on a device is advisory: a modified app can skip
it, so only work done on your server can be enforced.
