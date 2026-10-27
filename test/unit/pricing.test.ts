import { describe, expect, it } from "vitest";
import { EntitlerServer, EntitlerVisitor } from "../../src/index.js";
import { fakeFetch, json } from "./fake.js";

const aud = (amount: number, display: string) => ({ amount, currency: "aud", display });

const market = { id: "mk_au", key: "au", name: "Australia", currency: "aud", tax: "MARKET_TAX_INCLUDED" };

const plan = {
  id: "pl_1",
  key: "pro",
  name: "Pro",
  description: "For teams",
  kind: "PLAN_KIND_PLAN",
  productId: "pr_1",
  versionNumber: 2,
  byDefault: false,
  status: "PLAN_STATUS_ACTIVE",
  salesLed: false,
  priceState: "PLAN_PRICE_STATE_PRICED",
  trial: { days: 14 },
  quantity: { min: 1, max: 50 },
  periods: [{ id: "pe_1", key: "monthly", label: "Monthly", count: 1, unit: "PERIOD_UNIT_MONTHS" }],
  prices: [
    {
      periodId: "pe_1",
      price: aud(2000, "$20.00"),
      bands: [
        { upTo: 10, perUnit: true, amount: aud(2000, "$20.00") },
        { perUnit: true, amount: aud(1500, "$15.00") },
      ],
    },
  ],
  fees: [
    {
      key: "setup",
      name: "Setup",
      direction: "FEE_DIRECTION_DEBIT",
      price: aud(5000, "$50.00"),
      schedule: { onPurchase: {} },
    },
    {
      key: "rebate",
      name: "Rebate",
      direction: "FEE_DIRECTION_CREDIT",
      schedule: { yearlyOn: { dates: [{ month: 7, day: 1 }] } },
    },
    {
      key: "audit",
      name: "Audit",
      direction: "FEE_DIRECTION_DEBIT",
      schedule: { everyMonths: { months: 3, firstAfterMonths: 1 } },
    },
  ],
  items: [
    { featureKey: "export_pdf", value: { switch: true } },
    { featureKey: "ai_credits", value: { metered: { count: 1000 } }, bank: { unlimited: {} } },
    { featureKey: "spend", value: { money: { limits: [{ marketId: "mk_au", limit: { count: 5000 } }] } } },
  ],
  availableOn: [],
  listings: [
    {
      periodId: "pe_1",
      channels: [
        {
          connectionId: "co_1",
          name: "Stripe",
          mode: "CONNECTION_MODE_LIVE",
          provider: "PAYMENT_PROVIDER_STRIPE",
          purchasable: true,
          ids: { stripe: { priceId: "price_1" } },
          price: {
            amount: 2000,
            currency: "aud",
            interval: "LISTING_PRICE_INTERVAL_MONTH",
            intervalCount: 1,
            tax: "LISTING_TAX_BEHAVIOUR_INCLUSIVE",
          },
        },
      ],
    },
  ],
};

const sheet = {
  market,
  products: [{ id: "pr_1", key: "main", name: "Main", defaultPlanId: "pl_0" }],
  plans: [plan],
  served: { release: { id: "rl_1", number: 2 } },
  testers: false,
};

describe("pricing", () => {
  it("reads the plans on sale with a publishable key, in the market and locale asked for", async () => {
    const { fetch, sent } = fakeFetch(json({ pricing: sheet }));
    const visitor = new EntitlerVisitor({ key: "pk_test_1", fetch });
    const priced = await visitor.pricing({ market: "au", locale: "en-AU" });
    expect(sent[0]).toMatchObject({ method: "GET", path: "/v1/pricing", query: { market: "au" } });
    expect(sent[0]?.headers).toMatchObject({ authorization: "Bearer pk_test_1", "accept-language": "en-AU" });
    expect(priced).toMatchObject({
      market: { id: "mk_au", key: "au", name: "Australia", currency: "aud", tax: "included" },
      products: [{ id: "pr_1", key: "main", name: "Main", defaultPlanId: "pl_0" }],
      served: { track: null, source: { type: "release", id: "rl_1", number: 2 } },
      testers: false,
      customer: null,
    });
    expect(priced.plans[0]).toEqual({
      id: "pl_1",
      key: "pro",
      name: "Pro",
      description: "For teams",
      kind: "plan",
      product: "pr_1",
      version: 2,
      byDefault: false,
      status: "active",
      salesLed: false,
      priceState: "priced",
      trial: { days: 14, months: 0 },
      quantity: { min: 1, max: 50 },
      periods: [{ id: "pe_1", key: "monthly", label: "Monthly", count: 1, unit: "months" }],
      prices: [
        {
          period: "pe_1",
          price: aud(2000, "$20.00"),
          bands: [
            { upTo: 10, perUnit: true, amount: aud(2000, "$20.00") },
            { upTo: null, perUnit: true, amount: aud(1500, "$15.00") },
          ],
        },
      ],
      fees: [
        {
          key: "setup",
          name: "Setup",
          direction: "debit",
          price: aud(5000, "$50.00"),
          schedule: { type: "on_purchase" },
        },
        {
          key: "rebate",
          name: "Rebate",
          direction: "credit",
          price: null,
          schedule: { type: "yearly", dates: [{ month: 7, day: 1 }] },
        },
        {
          key: "audit",
          name: "Audit",
          direction: "debit",
          price: null,
          schedule: { type: "every_months", months: 3, firstAfterMonths: 1 },
        },
      ],
      items: [
        { feature: "export_pdf", value: true, markets: null, bank: null, benefitThousandths: null },
        { feature: "ai_credits", value: 1000, markets: null, bank: "unlimited", benefitThousandths: null },
        { feature: "spend", value: 0, markets: { mk_au: 5000 }, bank: null, benefitThousandths: null },
      ],
      availableOn: [],
      listings: [
        {
          period: "pe_1",
          channels: [
            {
              provider: "stripe",
              connectionId: "co_1",
              name: "Stripe",
              mode: "live",
              purchasable: true,
              ids: { priceId: "price_1" },
              price: { amount: 2000, currency: "aud", interval: "month", intervalCount: 1, tax: "inclusive" },
            },
          ],
        },
      ],
    });
  });

  it("keeps a sheet per locale", async () => {
    const { fetch, sent } = fakeFetch(json({ pricing: sheet }, 200, { "cache-control": "max-age=60" }));
    const server = new EntitlerServer({ key: "sk_test_1", fetch });
    await server.pricing({ country: "AU", locale: "en-AU" });
    await server.pricing({ country: "AU", locale: "en-AU" });
    await server.pricing({ country: "AU", locale: "fr-FR" });
    expect(sent.map((request) => [request.query.country, request.headers["accept-language"]])).toEqual([
      ["AU", "en-AU"],
      ["AU", "fr-FR"],
    ]);
  });

  it("reads a customer's pricing with what they pay now and next", async () => {
    const line = {
      planId: "pl_1",
      version: 2,
      periodId: "pe_1",
      quantity: 3,
      state: "PLAN_PRICE_STATE_PRICED",
      price: aud(5400, "$54.00"),
      unitPrice: aud(2000, "$20.00"),
      listPrice: aud(6000, "$60.00"),
      discounts: [{ offerId: "of_1", offerKey: "launch", offerName: "Launch", amount: aud(600, "$6.00") }],
    };
    const { fetch, sent } = fakeFetch(
      json({
        pricing: { ...sheet, customer: "user_1" },
        prices: {
          market,
          subscriptions: [
            {
              subscriptionId: "su_1",
              productId: "pr_1",
              renewsAt: 1_793_491_200,
              now: [line],
              nextCharges: [
                { feeKey: "audit", direction: "FEE_DIRECTION_DEBIT", at: 1_793_491_200, amount: aud(900, "$9.00") },
              ],
            },
          ],
        },
      }),
    );
    const pricing = await new EntitlerServer({ key: "sk_test_1", fetch }).customer("user_1").pricing();
    expect(sent[0]).toMatchObject({ method: "GET", path: "/v1/customers/user_1/pricing" });
    expect(pricing.customer).toBe("user_1");
    expect(pricing.prices?.subscriptions).toEqual([
      {
        subscriptionId: "su_1",
        product: "pr_1",
        renewsAt: new Date(1_793_491_200_000),
        now: [
          {
            planId: "pl_1",
            version: 2,
            period: "pe_1",
            quantity: 3,
            state: "priced",
            price: aud(5400, "$54.00"),
            unitPrice: aud(2000, "$20.00"),
            listPrice: aud(6000, "$60.00"),
            discounts: [{ offerId: "of_1", offerKey: "launch", offerName: "Launch", amount: aud(600, "$6.00") }],
          },
        ],
        atRenewal: null,
        nextCharges: [{ fee: "audit", direction: "debit", at: new Date(1_793_491_200_000), amount: aud(900, "$9.00") }],
      },
    ]);
  });

  it("builds a visitor client from a publishable key alone, and never shows it", () => {
    expect(() => new EntitlerVisitor({ key: " " })).toThrow(TypeError);
    const visitor = new EntitlerVisitor({ key: "pk_test_secretish" });
    expect(String(visitor)).not.toContain("pk_test_secretish");
    expect(visitor.toJSON()).toEqual({ baseUrl: "https://api.entitler.app", kind: "visitor" });
  });
});
