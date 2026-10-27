import { describe, expect, it } from "vitest";
import { EntitlerClient, EntitlerServer } from "../../src/index.js";
import { apiError, fakeFetch, json, type Reply } from "./fake.js";

const done = {
  done: {
    customerId: "cu_1",
    revision: 5,
    money: "CUSTOMER_MONEY_REAL",
    change: {
      productId: "pr_1",
      plan: {
        planId: "pl_2",
        planKey: "enterprise",
        planName: "Enterprise",
        versionNumber: 3,
        byDefault: false,
        money: "CUSTOMER_MONEY_REAL",
        periodId: "pe_yearly",
      },
      effective: "EFFECTIVE_NOW",
      at: 1_791_507_600,
      changed: true,
      policy: "SUBSCRIPTION_MOVE_POLICY_UPGRADE",
    },
  },
};

function setup(...replies: Reply[]) {
  const fake = fakeFetch(...replies);
  return { ...fake, customer: new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false }).customer("user_1") };
}

describe("setPlan", () => {
  it("moves the customer to a plan by its key and answers what changed", async () => {
    const { customer, sent } = setup(json(done));
    const step = await customer.setPlan("enterprise", {
      period: "pe_yearly",
      when: "now",
      until: new Date(1_794_099_600_000),
      offers: [{ key: "launch" }, { key: "loyal", percentThousandths: 12_500 }],
      market: "au",
      keepBilling: true,
      waiveExitCharges: false,
      reason: "Signed order 118",
    });
    expect(sent[0]).toMatchObject({
      method: "PUT",
      path: "/v1/customers/user_1/plan",
      body: {
        set: { planKey: "enterprise" },
        periodId: "pe_yearly",
        when: "SUBSCRIPTION_MOVE_WHEN_NOW",
        until: 1_794_099_600,
        offers: [{ offerKey: "launch" }, { offerKey: "loyal", value: { percentThousandths: 12_500 } }],
        market: "au",
        keepBilling: true,
        reason: "Signed order 118",
      },
    });
    expect(sent[0]?.body).not.toHaveProperty("waiveExitCharges");
    expect(step).toEqual({
      next: "done",
      result: {
        customerId: "cu_1",
        revision: 5,
        money: "real",
        change: {
          product: "pr_1",
          plan: {
            id: "pl_2",
            key: "enterprise",
            name: "Enterprise",
            version: 3,
            byDefault: false,
            money: "real",
            period: "pe_yearly",
          },
          quantity: null,
          effective: "now",
          at: new Date(1_791_507_600_000),
          until: null,
          changed: true,
          policy: "upgrade",
        },
        holdings: null,
      },
    });
  });

  it("ends the plan in a product with null", async () => {
    const { customer, sent } = setup(json({ done: { ...done.done, change: undefined } }));
    const step = await customer.setPlan(null, { product: "pr_1", when: "period_end", endBilling: true });
    expect(sent[0]?.body).toEqual({
      end: { productId: "pr_1" },
      when: "SUBSCRIPTION_MOVE_WHEN_PERIOD_END",
      endBilling: true,
    });
    expect(step).toMatchObject({ next: "done", result: { change: null } });
    await expect(customer.setPlan(null, {} as { product: string })).rejects.toBeInstanceOf(TypeError);
  });

  it("answers the payment step or a confirmation in flight", async () => {
    const { customer } = setup(
      json({ pay: { url: "https://pay.example/c/1", status: "PAYMENT_STEP_STATUS_REQUIRES_ACTION" } }),
      json({ confirming: {} }),
    );
    expect(await customer.setPlan("pro")).toEqual({
      next: "pay",
      url: "https://pay.example/c/1",
      status: "requires_action",
    });
    expect(await customer.setPlan("pro")).toEqual({ next: "confirming" });
  });

  it("retries a move that failed on the way, unless it names a revision", async () => {
    const retried = setup(apiError(503, "Unavailable"), json(done));
    await retried.customer.setPlan("pro");
    expect(retried.sent).toHaveLength(2);

    const once = setup(apiError(503, "Unavailable"));
    await expect(once.customer.setPlan("pro", { expectedRevision: 4 })).rejects.toMatchObject({ status: 503 });
    expect(once.sent).toHaveLength(1);
    expect(once.sent[0]?.body).toMatchObject({ expectedRevision: { value: 4 } });
  });

  it("refuses a market and a country together, sending nothing", async () => {
    const { customer, sent } = setup(json(done));
    await expect(customer.setPlan("pro", { market: "au", country: "AU" })).rejects.toBeInstanceOf(TypeError);
    expect(sent).toHaveLength(0);
  });
});

describe("add-ons", () => {
  it("sets, removes and undoes a change to an add-on named in the path", async () => {
    const { customer, sent } = setup(json(done));
    await customer.setAddOn("seats", { quantity: 5, replaces: "seats_small", register: true });
    await customer.removeAddOn("seats", { reason: "Downsized" });
    await customer.undoAddOnChange("seats");
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      [
        "PUT",
        "/v1/customers/user_1/add-ons/seats",
        { quantity: 5, replaces: { planKey: "seats_small" }, register: true },
      ],
      ["POST", "/v1/customers/user_1/add-ons/seats:remove", { reason: "Downsized" }],
      ["POST", "/v1/customers/user_1/add-ons/seats:cancelPendingChange", {}],
    ]);
  });
});

describe("the customer's own moves", () => {
  it("subscribes the signed-in customer, never retrying", async () => {
    const { fetch, sent } = fakeFetch(apiError(503, "Unavailable"));
    const entitler = new EntitlerClient({ token: "ct_1", fetch, cache: false });
    await expect(
      entitler.me.subscribe("pro", {
        period: "pe_monthly",
        quantity: 2,
        offer: { code: "SPRING" },
        country: "AU",
        returnUrl: "https://app.example/billing",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers/me/subscription",
      body: {
        plan: { planKey: "pro" },
        periodId: "pe_monthly",
        quantity: 2,
        offer: { code: "SPRING" },
        country: "AU",
        returnUrl: "https://app.example/billing",
      },
    });
  });

  it("cancels, and undoes a booked change, in one product", async () => {
    const { customer, sent } = setup(json(done));
    await customer.subscribe("pro", { offer: { key: "launch" } });
    await customer.cancel({ product: "pr_1", endsAt: new Date(1_794_099_600_000) });
    await customer.undoPendingChange({ product: "pr_1" });
    expect(sent.map((request) => [request.path, request.body])).toEqual([
      ["/v1/customers/user_1/subscription", { plan: { planKey: "pro" }, offer: { offerKey: "launch" } }],
      ["/v1/customers/user_1/subscription:cancel", { productId: "pr_1", endsAt: 1_794_099_600 }],
      ["/v1/customers/user_1/subscription:cancelPendingChange", { productId: "pr_1" }],
    ]);
    await expect(customer.cancel({ endsAt: new Date(Number.NaN) })).rejects.toBeInstanceOf(TypeError);
  });
});
