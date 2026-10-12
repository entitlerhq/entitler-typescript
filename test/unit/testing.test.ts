import { describe, expect, it } from "vitest";
import { defineFeature, UsageRefusedError, UsageReplayedError } from "../../src/index.js";
import {
  decodeBatchResult,
  decodeBillingSync,
  decodeCheck,
  decodeCustomerBilling,
  decodeCustomerPage,
  decodeCustomerSummary,
  decodeCustomerToken,
  decodeCustomerTrack,
  decodeDetails,
  decodeEntitlements,
  decodeFeatureList,
  decodeGrantChange,
  decodeIssuedSnapshot,
  decodePlanChange,
  decodePlans,
  decodePricing,
  decodeProviderPage,
  decodeRegistered,
  decodeScopes,
  decodeSnapshotKeys,
  decodeStep,
  decodeUsage,
  decodeUsageResult,
} from "../../src/shapes.js";
import { answers, fakeCustomer } from "../../src/testing.js";

const credits = defineFeature("ai_credits", "metered");
const exportPdf = defineFeature("export_pdf", "boolean");

describe("fakeCustomer", () => {
  it("answers reads from its values, and a missing feature as feature_not_found", async () => {
    const customer = fakeCustomer({ export_pdf: true, ai_credits: { value: 100, used: 97 } }, { id: "user_1" });
    const check = await customer.check(exportPdf);
    expect(check).toMatchObject({ customer: "user_1", feature: "export_pdf", entitled: true, value: true });
    const meter = await customer.check(credits);
    expect(meter).toMatchObject({ value: 100, used: 97, remaining: 3, entitled: true });
    await expect(customer.check("sso")).rejects.toMatchObject({ status: 404, code: "feature_not_found" });
    expect(await customer.isEntitled("sso", { default: false })).toBe(false);
    const entitlements = await customer.entitlements();
    expect(entitlements.has(exportPdf)).toBe(true);
    expect(entitlements.get(credits)?.remaining).toBe(3);
  });

  it("moves meters by the usage rules and replays a reused key", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 100, used: 97 } });
    const refused = await customer.recordUsage(credits, 5, { idempotencyKey: "job-1" });
    expect(refused).toMatchObject({ outcome: "refused", refusal: "over_allowance" });
    const recorded = await customer.recordUsage(credits, 2, { idempotencyKey: "job-2" });
    expect(recorded).toMatchObject({ outcome: "recorded", used: 99, replayed: false });
    const replayed = await customer.recordUsage(credits, 2, { idempotencyKey: "job-2" });
    expect(replayed).toMatchObject({ outcome: "duplicate", used: 99, meterChange: 0, replayed: true });
    await expect(customer.startHold(credits, 5, { idempotencyKey: "job-3" })).rejects.toBeInstanceOf(UsageRefusedError);
    const hold = await customer.startHold(credits, 1, { idempotencyKey: "job-4" });
    hold.use(1);
    expect(await hold.finish()).toMatchObject({ outcome: "settled", used: 100 });
    const observed = await customer.recordUsage(credits, 3, { idempotencyKey: "job-5", mode: "observe" });
    expect(observed).toMatchObject({ used: 103, overBy: 3 });
  });

  it("records writes in order and lets a test replace one method's answer", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10 } });
    const step = await customer.subscribe("pro", { period: "monthly" });
    expect(step).toMatchObject({ next: "done", effective: "now", changed: true, replayed: false });
    customer.answer("subscribe", () => ({ next: "pay", url: "https://checkout.example/1" }));
    expect(await customer.subscribe("pro")).toEqual({ next: "pay", url: "https://checkout.example/1" });
    expect(await customer.setPlan("enterprise", { billing: "end" })).toMatchObject({ changed: true });
    await customer.erase();
    expect(customer.writes.map((write) => write.method)).toEqual(["subscribe", "subscribe", "setPlan", "erase"]);
    expect(customer.writes[0]?.args).toEqual(["pro", { period: "monthly" }]);
    expect(await customer.billingPortal({ returnUrl: "https://app.example" })).toMatchObject({ provider: "stripe" });
  });

  it("replays a hold's key by the hold's state", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10 } });
    const hold = await customer.startHold(credits, 2, { idempotencyKey: "hold-1" });
    const again = await customer.startHold(credits, 2, { idempotencyKey: "hold-1" });
    expect(again).toMatchObject({ id: hold.id, duplicate: true });
    await hold.finish();
    await expect(customer.startHold(credits, 2, { idempotencyKey: "hold-1" })).rejects.toBeInstanceOf(
      UsageReplayedError,
    );
    await expect(customer.releaseUsage(hold.id)).rejects.toMatchObject({ status: 409, code: "hold_settled" });
  });

  it("cancels a usage report, once", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10, used: 1 } });
    const recorded = await customer.recordUsage(credits, 3, { idempotencyKey: "job-1" });
    const cancelled = await customer.cancelUsage(recorded.id as string);
    expect(cancelled).toMatchObject({ outcome: "cancelled", used: 1, meterChange: -3 });
    expect(await customer.recordUsage(credits, 3, { idempotencyKey: "job-1" })).toMatchObject({
      outcome: "cancelled",
      replayed: true,
    });
  });

  it("keeps a usage log whose entries carry by, actor and reason", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10 } });
    const recorded = await customer.recordUsage(credits, 2, { idempotencyKey: "job-1" });
    await customer.adjustMeter(credits, { to: 1, actor: "support", reason: "Outage.", idempotencyKey: "adjust-1" });
    await customer.cancelUsage(recorded.id as string, { actor: "support", reason: "Charged twice." });
    const log = (await customer.usage()).log.items;
    expect(log.map((entry) => [entry.kind, entry.by, entry.actor, entry.reason, entry.cancelledAt !== null])).toEqual([
      ["adjust", "Server key", "support", "Outage.", false],
      ["use", "Server key", "support", "Charged twice.", true],
    ]);
    expect((await customer.details()).usage.items).toHaveLength(2);
  });

  it("logs a settlement above 0 as a use, and holds, releases and a 0 settlement as nothing", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10 } });
    const settled = await customer.startHold(credits, 4, { idempotencyKey: "hold-1" });
    settled.use(3);
    const result = await settled.finish();
    await (await customer.startHold(credits, 2, { idempotencyKey: "hold-2" })).release();
    const empty = await customer.startHold(credits, 2, { idempotencyKey: "hold-3" });
    empty.use(0);
    await empty.finish();
    const log = (await customer.usage()).log.items;
    expect(log.map((entry) => [entry.id, entry.kind, entry.amount])).toEqual([[result.id, "use", 3]]);
    expect((await customer.details()).usage.items).toHaveLength(1);
    await customer.cancelUsage(result.id as string);
    expect((await customer.usage()).log.items[0]?.cancelledAt).toBeInstanceOf(Date);
  });

  it("answers every method through the real decoders", async () => {
    const customer = fakeCustomer({ export_pdf: true, ai_credits: { value: 10, used: 4 } }, { id: "user_1" });
    const usage = await customer.usage();
    expect(usage.features.map((feature) => [feature.feature, feature.used, feature.remaining])).toEqual([
      ["ai_credits", 4, 6],
    ]);
    const calls: (() => Promise<unknown>)[] = [
      () => customer.check(exportPdf),
      () => customer.entitlements(),
      () => customer.plans(),
      () => customer.pricing(),
      () => customer.details(),
      () => customer.billing(),
      () => customer.register({ name: "Ada" }),
      () => customer.update({ name: "Ada" }),
      () => customer.token(),
      () => customer.snapshot(),
      () => customer.setTrack("Beta"),
      () => customer.subscribe("pro"),
      () => customer.cancel(),
      () => customer.undoPendingChange(),
      () => customer.billingPortal({ returnUrl: "https://app.example" }),
      () => customer.syncBilling(),
      () => customer.setPlan("pro"),
      () => customer.setAddOn("seats", { quantity: 2 }),
      () => customer.grant("sso"),
      () => customer.revokeGrant("grt_1"),
      () => customer.adjustMeter(credits, { by: 1, idempotencyKey: "adjust-1" }),
      () => customer.erase(),
    ];
    for (const call of calls) await expect(call()).resolves.not.toBeInstanceOf(Error);
    expect((await customer.update({ name: "Grace" })).name).toBe("Grace");
  });

  it("types answer() by the method it replaces", () => {
    const customer = fakeCustomer({});
    // @ts-expect-error entitled is a boolean, and a check has more fields
    customer.answer("check", () => ({ entitled: "yes" }));
    // @ts-expect-error id is not a method
    expect(() => customer.answer("id", () => "x")).toThrow(TypeError);
  });
});

describe("answers", () => {
  it("builds bodies the real decoders read", () => {
    const wire = (body: unknown) => JSON.parse(JSON.stringify(body));
    expect(() => decodeCheck(wire(answers.check({ feature: "export_pdf" })))).not.toThrow();
    expect(() => decodeCheck(wire(answers.check({ feature: "ai_credits", used: 3, value: 10 })))).not.toThrow();
    const cases: [unknown, (value: unknown) => unknown][] = [
      [answers.entitlements({ entitlements: [answers.entitlement({ key: "sso" })] }), decodeEntitlements],
      [answers.plans({ options: [answers.moveOption()] }), decodePlans],
      [answers.pricing(), decodePricing],
      [answers.usageResult({ feature: "ai_credits" }), decodeUsageResult],
      [answers.planChange(), decodePlanChange],
      [answers.subscribeStep(), decodeStep],
      [answers.grantChange(), decodeGrantChange],
      [answers.registered(), decodeRegistered],
      [answers.customerToken(), decodeCustomerToken],
      [answers.subscribeStep({ next: "pay" }), decodeStep],
      [answers.subscribeStep({ next: "confirming" }), decodeStep],
      [answers.subscribeStep({ next: "manage" }), decodeStep],
      [answers.usage({ features: [answers.featureUsage({ feature: "ai_credits", value: 5 })] }), decodeUsage],
      [
        answers.details({
          activity: [answers.activity()],
          usage: { items: [answers.usageEvent({ feature: "ai_credits" })], next: null },
        }),
        decodeDetails,
      ],
      [answers.customerSummary(), decodeCustomerSummary],
      [answers.customerPage({ items: [answers.customerSummary()] }), decodeCustomerPage],
      [answers.features(), decodeFeatureList],
      [answers.scopes(), decodeScopes],
      [answers.snapshotKeys(), decodeSnapshotKeys],
      [answers.snapshot(), decodeIssuedSnapshot],
      [answers.customerTrack(), decodeCustomerTrack],
      [answers.providerPage(), decodeProviderPage],
      [answers.billingSync(), decodeBillingSync],
      [answers.customerBilling(), decodeCustomerBilling],
      [answers.batchResult({ results: [{}, { outcome: "duplicate" }] }), decodeBatchResult],
    ];
    for (const [body, decode] of cases) expect(() => decode(wire(body))).not.toThrow();
  });
});

describe("the fake's refusals", () => {
  it("refuses a gated report and a hold with not_entitled when the meter's value is 0", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 0 } });
    expect(await customer.recordUsage(credits, 1, { idempotencyKey: "r1" })).toMatchObject({
      outcome: "refused",
      refusal: "not_entitled",
    });
    const error = await customer.startHold(credits, 1, { idempotencyKey: "h1" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageRefusedError);
    expect((error as UsageRefusedError).result.refusal).toBe("not_entitled");
    expect(await customer.recordUsage(credits, 1, { idempotencyKey: "o1", mode: "observe" })).toMatchObject({
      outcome: "recorded",
    });
  });

  it("refuses past the allowance with over_allowance", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10, used: 10 } });
    expect(await customer.recordUsage(credits, 1, { idempotencyKey: "r1" })).toMatchObject({
      refusal: "over_allowance",
    });
    const error = await customer.startHold(credits, 5, { idempotencyKey: "h1" }).catch((caught: unknown) => caught);
    expect((error as UsageRefusedError).result.refusal).toBe("over_allowance");
    const partly = fakeCustomer({ ai_credits: { value: 10, used: 8 } });
    expect(await partly.recordUsage(credits, 3, { idempotencyKey: "r2" })).toMatchObject({
      refusal: "over_allowance",
    });
  });
});
