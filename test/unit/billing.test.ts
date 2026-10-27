import { describe, expect, it } from "vitest";
import { EntitlerClient, EntitlerServer } from "../../src/index.js";
import { fakeFetch, json, type Reply } from "./fake.js";

const aud = (amount: number, display: string) => ({ amount, currency: "aud", display });

const heldPlan = {
  planId: "pl_1",
  planKey: "pro",
  planName: "Pro",
  versionNumber: 2,
  byDefault: false,
  money: "CUSTOMER_MONEY_REAL",
  periodId: "pe_monthly",
};

const holdings = {
  lanes: [
    {
      productId: "pr_1",
      plan: heldPlan,
      addOns: [
        {
          planId: "pl_9",
          planKey: "seats",
          planName: "Seats",
          versionNumber: 2,
          money: "CUSTOMER_MONEY_REAL",
          quantity: 5,
          required: false,
          addedAt: 1_791_000_000,
        },
      ],
      startedAt: 1_790_000_000,
      renewsAt: 1_793_491_200,
      collection: "SUBSCRIPTION_COLLECTION_BUSINESS",
      periodsAhead: 0,
      scheduledChanges: [],
      pending: { at: 1_793_491_200, move: { planId: "pl_0", periodId: "pe_monthly" } },
      cancellation: { endsAt: 1_793_491_200, exitFee: aud(5000, "$50.00") },
      discounts: [
        {
          offerId: "of_1",
          offerKey: "launch",
          offerName: "Launch",
          planIds: ["pl_1"],
          periodIds: [],
          givenBy: "DISCOUNT_GIVEN_BY_CODE",
          givenAt: 1_790_000_000,
          applied: true,
          fees: [],
          percentThousandths: 10_000,
        },
      ],
      paymentAmount: aud(2000, "$20.00"),
      paymentDueAt: 1_793_491_200,
      paymentDays: 14,
    },
  ],
  grants: [],
};

const plans = {
  asOf: 1_791_507_600,
  customerId: "cu_1",
  holdings,
  options: [
    {
      planId: "pl_2",
      planKey: "team",
      planName: "Team",
      productId: "pr_1",
      kind: "OPTION_KIND_MOVE",
      direction: "PLAN_DIRECTION_UP",
      selling: "SELLING_SELF_SERVE",
      timing: "MOVE_TIMING_NOW_KEEP",
      periodIds: ["pe_monthly", "pe_yearly"],
      impact: [
        { featureKey: "export_pdf", kind: "IMPACT_KIND_GAINS", to: { switch: true } },
        {
          featureKey: "spend",
          kind: "IMPACT_KIND_CHANGES",
          from: { money: { limits: [{ marketId: "mk_au", limit: { count: 5000 } }] } },
          to: { money: { limits: [{ marketId: "mk_au", limit: { unlimited: {} } }] } },
        },
      ],
    },
  ],
};

function setup(...replies: Reply[]) {
  const fake = fakeFetch(...replies);
  return { ...fake, customer: new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false }).customer("user_1") };
}

describe("plans", () => {
  it("reads the plans on offer with what each would change, and what the customer holds", async () => {
    const { customer, sent } = setup(json(plans));
    const answer = await customer.plans({ asOf: new Date(1_791_507_600_000) });
    expect(sent[0]).toMatchObject({
      method: "GET",
      path: "/v1/customers/user_1/plans",
      query: { as_of: "1791507600" },
    });
    expect(answer).toMatchObject({ asOf: new Date(1_791_507_600_000), customerId: "cu_1", stale: false });
    expect(answer.options).toEqual([
      {
        plan: { id: "pl_2", key: "team", name: "Team" },
        product: "pr_1",
        kind: "move",
        direction: "up",
        selling: "self_serve",
        timing: "now_keep",
        periods: ["pe_monthly", "pe_yearly"],
        replaces: null,
        impact: [
          { feature: "export_pdf", kind: "gains", from: null, to: true, fromMarkets: null, toMarkets: null },
          {
            feature: "spend",
            kind: "changes",
            from: 0,
            to: 0,
            fromMarkets: { mk_au: 5000 },
            toMarkets: { mk_au: "unlimited" },
          },
        ],
      },
    ]);
    expect(answer.holdings?.lanes[0]).toEqual({
      product: "pr_1",
      plan: { id: "pl_1", key: "pro", name: "Pro", version: 2, byDefault: false, money: "real", period: "pe_monthly" },
      addOns: [
        {
          id: "pl_9",
          key: "seats",
          name: "Seats",
          version: 2,
          money: "real",
          quantity: 5,
          required: false,
          addedAt: new Date(1_791_000_000_000),
        },
      ],
      startedAt: new Date(1_790_000_000_000),
      renewsAt: new Date(1_793_491_200_000),
      trialEndsAt: null,
      cancelsAt: null,
      paidUntil: null,
      until: null,
      collection: "business",
      pending: { at: new Date(1_793_491_200_000), cancel: false, plan: "pl_0", period: "pe_monthly" },
      cancellation: { endsAt: new Date(1_793_491_200_000), exitFee: aud(5000, "$50.00"), chargedBack: null },
      discounts: [
        {
          offerKey: "launch",
          offerName: "Launch",
          amount: null,
          percentThousandths: 10_000,
          until: null,
          applied: true,
        },
      ],
      payment: { amount: aud(2000, "$20.00"), dueAt: new Date(1_793_491_200_000), days: 14 },
    });
  });

  it("answers a booked cancellation, and holdings after a move", async () => {
    const lane = { ...holdings.lanes[0], pending: { at: 1_793_491_200, cancel: {} } };
    const { customer } = setup(
      json({ ...plans, holdings: { lanes: [lane], grants: [] } }),
      json({ done: { customerId: "cu_1", revision: 6, money: "CUSTOMER_MONEY_REAL", holdings } }),
    );
    expect((await customer.plans()).holdings?.lanes[0]?.pending).toEqual({
      at: new Date(1_793_491_200_000),
      cancel: true,
      plan: null,
      period: null,
    });
    const step = await customer.setPlan("pro");
    expect(step.next === "done" && step.result.holdings?.lanes[0]?.product).toBe("pr_1");
  });
});

describe("billing", () => {
  it("opens the provider's page and syncs from the provider for the signed-in customer", async () => {
    const { fetch, sent } = fakeFetch((request) =>
      request.path.endsWith("/portal-sessions")
        ? json({ url: "https://billing.example/s/1" })
        : json({ changed: true }),
    );
    const entitler = new EntitlerClient({ token: "ct_1", fetch, cache: false });
    expect(await entitler.me.billingPortal({ returnUrl: "https://app.example/account" })).toEqual({
      url: "https://billing.example/s/1",
    });
    expect(await entitler.me.syncBilling()).toEqual({ changed: true });
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/v1/customers/me/billing/portal-sessions", { returnUrl: "https://app.example/account" }],
      ["POST", "/v1/customers/me/billing:sync", {}],
    ]);
    await expect(entitler.me.billingPortal({} as { returnUrl: string })).rejects.toBeInstanceOf(TypeError);
  });

  it("reads the provider's view of the customer", async () => {
    const sku = {
      priceId: "price_1",
      periodId: "pe_monthly",
      price: {
        amount: 2000,
        currency: "aud",
        interval: "LISTING_PRICE_INTERVAL_MONTH",
        intervalCount: 1,
        tax: "LISTING_TAX_BEHAVIOUR_INCLUSIVE",
      },
    };
    const { customer, sent } = setup(
      json({
        billing: {
          linked: true,
          connectionId: "co_1",
          status: "PROVIDER_SUBSCRIPTION_STATUS_PAST_DUE",
          items: 1,
          renews: true,
          sku,
          drift: { billedPlanId: "pl_2", heldPlanId: "pl_1", observedAt: 1_791_507_600 },
          products: [
            {
              productId: "pr_1",
              connectionId: "co_1",
              status: "PROVIDER_SUBSCRIPTION_STATUS_ACTIVE",
              items: 1,
              renews: false,
            },
          ],
        },
      }),
    );
    expect(await customer.billing()).toEqual({
      linked: true,
      connectionId: "co_1",
      status: "past_due",
      items: 1,
      renews: true,
      sku: {
        priceId: "price_1",
        period: "pe_monthly",
        price: { amount: 2000, currency: "aud", interval: "month", intervalCount: 1, tax: "inclusive" },
      },
      drift: { billedPlan: "pl_2", heldPlan: "pl_1", product: null, observedAt: new Date(1_791_507_600_000) },
      products: [
        {
          product: "pr_1",
          connectionId: "co_1",
          status: "active",
          items: 1,
          renews: false,
          sku: null,
          drift: null,
        },
      ],
    });
    expect(sent[0]).toMatchObject({ method: "GET", path: "/v1/customers/user_1/billing" });
  });

  it("answers an unlinked customer as not linked", async () => {
    const { customer } = setup(json({}));
    expect(await customer.billing()).toEqual({
      linked: false,
      connectionId: null,
      status: "unspecified",
      items: 0,
      renews: false,
      sku: null,
      drift: null,
      products: [],
    });
  });
});
