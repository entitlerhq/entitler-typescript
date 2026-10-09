import { describe, expect, it } from "vitest";
import { ApiError, defineFeature, UsageRefusedError } from "../../src/index.js";
import { isCheck } from "../../src/shapes.js";
import { answers, fakeCustomer } from "../../src/testing.js";
import { parseAnswer } from "../../src/transport.js";

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
    expect(replayed).toMatchObject({ outcome: "recorded", used: 99, replayed: true });
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
    await expect(customer.billingPortal({ returnUrl: "https://app.example" })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("answers", () => {
  it("builds bodies the real decoder reads", () => {
    const check = parseAnswer(JSON.stringify(answers.check({ feature: "export_pdf" }))) as Record<string, unknown>;
    expect(isCheck(check)).toBe(true);
    const metered = parseAnswer(JSON.stringify(answers.check({ feature: "ai_credits", used: 3, value: 10 })));
    expect(isCheck(metered as Record<string, unknown>)).toBe(true);
    for (const body of [
      answers.entitlements({ entitlements: [answers.entitlement({ key: "sso" })] }),
      answers.plans({ options: [answers.moveOption()] }),
      answers.pricing(),
      answers.usageResult({ feature: "ai_credits" }),
      answers.planChange(),
      answers.subscribeStep(),
      answers.grantChange(),
      answers.registered(),
      answers.customerToken(),
    ]) {
      expect(() => parseAnswer(JSON.stringify(body))).not.toThrow();
    }
  });
});
