# Testing your app

Test your own gating, usage and billing code without the network, from the separate entry point
`@entitlerhq/entitler/testing`, which the main entry never imports, so bundles leave it out.

## A fake customer

`fakeCustomer(values, { id, plans, pricing })` answers a `ServerCustomer` that makes no request.
`values` maps feature keys to a value (`true`, an amount, `"unlimited"`) or a meter
(`{ value, used }`):

```ts
import { type Customer, defineFeature } from "@entitlerhq/entitler";
import { fakeCustomer } from "@entitlerhq/entitler/testing";

const aiCredits = defineFeature("ai_credits", "metered");

async function summarise(customer: Customer, jobId: string) {
  const result = await customer.recordUsage(aiCredits, 5, { idempotencyKey: jobId });
  return result.outcome === "refused" ? "Upgrade for more credits." : "Summarised.";
}

const fake = fakeCustomer({ export_pdf: true, ai_credits: { value: 100, used: 97 } });
console.log(await summarise(fake, "job-1"));
console.log(fake.writes.map((write) => write.method));
```

- Reads answer complete `Check` and `Entitlements` values. A key it does not hold answers
  `404 feature_not_found`, so `isEntitled` answers its default.
- Usage writes move the meters as Entitler would: a gated report past the allowance answers
  `refused`, holds settle and release, and a reused key replays with `replayed` true.
- Every write is kept in `writes`, in order, with its method and arguments. Writes it does not model
  answer a plain success (`subscribe` a `done` step made now, `setPlan` and the other billing writes a
  `PlanChange` made now); `answer(method, fn)` replaces one method's answer:

```ts
import { fakeCustomer } from "@entitlerhq/entitler/testing";

const paying = fakeCustomer({ export_pdf: 0 });
paying.answer("subscribe", () => ({ next: "pay", url: "https://checkout.stripe.com/c/test" }));
```

## Faking `fetch`

Tests that exercise the real client against a fake `fetch` build answer bodies with `answers`, so a
fixture missing one field never decodes as `invalid_response` and passes a test for the wrong reason:

```ts
import { EntitlerServer } from "@entitlerhq/entitler";
import { answers } from "@entitlerhq/entitler/testing";

const testServer = new EntitlerServer({
  key: "ent_test_fake",
  maxRetries: 0,
  cache: false,
  fetch: async () => Response.json(answers.check({ feature: "export_pdf", entitled: true })),
});
console.log((await testServer.customer("user_1").check("export_pdf")).entitled);
```

Set `maxRetries: 0` and `cache: false` in tests, so a failure answers at once and every call reaches
your fake. With fake timers, the retry waits and timeouts use `setTimeout` and `AbortSignal.timeout`,
which some fake clocks leave real: advance real time, or keep `maxRetries` at 0.
