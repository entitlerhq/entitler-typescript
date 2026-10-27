import { describe, expect, it } from "vitest";
import { ApiError, defineFeature, UsageRefusedError } from "../../src/index.js";
import { fakeCustomer } from "../../src/testing.js";

const aiCredits = defineFeature("ai_credits", "metered");

describe("fakeCustomer", () => {
  it("answers the features it holds, and refuses one it doesn't", async () => {
    const customer = fakeCustomer({ export_pdf: true, seats: 5, ai_credits: { value: 1000, used: 990 } });
    expect(await customer.check("export_pdf")).toMatchObject({ entitled: true, value: true });
    expect(await customer.check("seats")).toMatchObject({ type: "configuration", value: 5 });
    expect(await customer.check(aiCredits)).toMatchObject({ meter: { used: 990, remaining: 10 } });
    expect((await customer.entitlements()).has("export_pdf")).toBe(true);
    expect(await customer.isEntitled("missing", { default: false })).toBe(false);
    await expect(customer.check("missing")).rejects.toMatchObject({ reason: "FEATURE_NOT_FOUND" });
    expect(customer.id).toBe("customer_1");
    expect(customer.writes).toEqual([]);
  });

  it("records usage within the allowance, refuses past it, and repeats a key's first answer", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 10 } }, { id: "user_1" });
    const first = await customer.recordUsage(aiCredits, 8, { idempotencyKey: "job-1" });
    expect(first).toMatchObject({ outcome: "recorded", amount: 8, meter: { used: 8, remaining: 2 } });
    expect(await customer.recordUsage(aiCredits, 8, { idempotencyKey: "job-1" })).toMatchObject({
      outcome: "recorded",
      replayed: true,
      id: first.id,
    });
    expect(await customer.recordUsage(aiCredits, 3, { idempotencyKey: "job-2" })).toMatchObject({
      outcome: "refused",
      refusal: "over_allowance",
    });
    expect(await customer.recordUsage(aiCredits, 3, { idempotencyKey: "job-3", mode: "observe" })).toMatchObject({
      outcome: "recorded",
      overBy: 1,
    });
    await expect(customer.recordUsage(aiCredits, 2, { idempotencyKey: "job-1" })).rejects.toMatchObject({
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(await customer.cancelUsage(first.id as string)).toMatchObject({ outcome: "cancelled", meter: { used: 3 } });
    expect(customer.writes.map((write) => write.method)).toEqual([
      "recordUsage",
      "recordUsage",
      "recordUsage",
      "recordUsage",
      "recordUsage",
      "cancelUsage",
    ]);
  });

  it("holds while work runs, settles what it used, and refuses a hold past the allowance", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 100 } });
    const answer = await customer.withHold(
      aiCredits,
      50,
      async ({ hold }) => {
        expect((await customer.check(aiCredits)).meter).toMatchObject({ held: 50, remaining: 50 });
        hold.use(20);
        return "done";
      },
      { idempotencyKey: "msg-1" },
    );
    expect(answer).toBe("done");
    expect((await customer.check(aiCredits)).meter).toMatchObject({ used: 20, held: 0, remaining: 80 });
    await expect(customer.startHold(aiCredits, 81, { idempotencyKey: "msg-2" })).rejects.toBeInstanceOf(
      UsageRefusedError,
    );
    const hold = await customer.startHold(aiCredits, 30, { idempotencyKey: "msg-3" });
    await hold.release();
    expect((await customer.check(aiCredits)).meter).toMatchObject({ used: 20, held: 0 });
    await expect(customer.settleUsage(hold.id, 1)).rejects.toMatchObject({ reason: "HOLD_RELEASED" });
    expect(customer.writes.map((write) => write.method)).toEqual(["withHold", "startHold", "startHold", "settleUsage"]);
  });

  it("answers other methods only when given their answer, and logs writes", async () => {
    const customer = fakeCustomer({});
    await expect(customer.plans()).rejects.toThrow('give its answer with answer("plans", fn)');
    customer.answer("setPlan", async (plan) => ({
      next: "pay",
      url: `https://pay.example/${plan}`,
      status: "checkout",
    }));
    expect(await customer.setPlan("pro")).toEqual({ next: "pay", url: "https://pay.example/pro", status: "checkout" });
    expect(customer.writes).toEqual([{ method: "setPlan", args: ["pro"] }]);
    await expect(customer.recordUsage(aiCredits, 1, { idempotencyKey: "k" })).rejects.toBeInstanceOf(ApiError);
  });
});
