import { describe, expect, it } from "vitest";
import { ApiError, EntitlerServer } from "../../src/index.js";
import { context, detailsAnswer, fakeFetch, json } from "./fake.js";

function serverFor(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return { ...fake, server: new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false, maxRetries: 0 }) };
}

const summary = {
  id: "cus_1",
  externalId: "user_1",
  name: "Ada",
  email: "ada@example.com",
  environmentId: "env_1",
  sample: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  plan: null,
  plans: [],
  defaultPlan: null,
  status: "active",
  kind: "default",
  metadata: {},
  track: context.track,
  testCustomer: false,
};

const metadata = { from: "hubspot", at: "desk", since: "2019", until: "2026-01-01T00:00:00Z" };

describe("instants decode at their schema paths only", () => {
  it("keeps customer metadata named like instants as strings, in details", async () => {
    const { server } = serverFor(json(detailsAnswer({ customer: { ...summary, metadata } })));
    const details = await server.customer("user_1").details();
    expect(details.customer.metadata).toEqual(metadata);
    expect(details.customer.createdAt).toBeInstanceOf(Date);
  });

  it("keeps metadata as strings in the customer list and in update", async () => {
    const { server } = serverFor(
      json({ items: [{ ...summary, metadata }], next: null, used: 1, limit: null }),
      json({ ...summary, metadata }),
    );
    for await (const item of server.customers.list()) expect(item.metadata).toEqual(metadata);
    expect((await server.customer("user_1").update({ name: "Ada" })).metadata).toEqual(metadata);
  });

  it("keeps a pricing plan's feature values named like instants", async () => {
    const plan = {
      id: "pln_pro",
      key: "pro",
      name: "Pro",
      description: "",
      kind: "plan",
      product: null,
      salesLed: false,
      status: "active",
      version: 1,
      default: false,
      periods: [],
      attachesTo: [],
      features: { until: "unlimited", at: 5, from: true },
      listings: [],
    };
    const { server } = serverFor(json({ ...context, customer: null, defaultPlan: null, products: [], plans: [plan] }));
    const pricing = await server.pricing();
    expect(pricing.plans[0]?.features).toEqual({ until: "unlimited", at: 5, from: true });
  });

  it("refuses an impossible date in an answer", async () => {
    const { server } = serverFor(json(detailsAnswer({ asOf: "2026-02-30T00:00:00Z" })));
    await expect(server.customer("user_1").details()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses an impossible date in a request", async () => {
    const { server, sent } = serverFor(json({}));
    await expect(server.customer("user_1").setPlan("pro", { until: "2026-02-31T00:00:00Z" })).rejects.toThrow(
      TypeError,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("the fetch option", () => {
  it("takes any function from a URL and init to a response, with no other members", async () => {
    const server = new EntitlerServer({
      key: "k",
      cache: false,
      fetch: async () => Response.json({ scopes: ["plans:read"] }),
    });
    expect(await server.scopes()).toEqual({ scopes: ["plans:read"] });
  });
});

describe("every answer is checked against its schema", () => {
  it.each([
    ["scopes", (server: EntitlerServer) => server.scopes()],
    ["features", (server: EntitlerServer) => server.features()],
    ["pricing", (server: EntitlerServer) => server.pricing()],
    ["snapshotKeys", (server: EntitlerServer) => server.snapshotKeys()],
    ["usage", (server: EntitlerServer) => server.customer("user_1").usage()],
    ["details", (server: EntitlerServer) => server.customer("user_1").details()],
    ["billing", (server: EntitlerServer) => server.customer("user_1").billing()],
    ["register", (server: EntitlerServer) => server.customer("user_1").register()],
    ["token", (server: EntitlerServer) => server.customer("user_1").token()],
    ["setTrack", (server: EntitlerServer) => server.customer("user_1").setTrack("Beta")],
    ["update", (server: EntitlerServer) => server.customer("user_1").update({ name: "Ada" })],
    [
      "customers.list",
      async (server: EntitlerServer) => {
        for await (const _ of server.customers.list()) break;
      },
    ],
  ])("answers invalid_response for an empty %s answer", async (_name, call) => {
    const { server } = serverFor(json({}));
    const error = await call(server).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "invalid_response" });
  });

  it("answers a batch chunk's events error when its answer does not decode", async () => {
    const { server } = serverFor(json({}));
    const aiCredits = { key: "ai_credits", type: "metered", includes: [] } as const;
    const result = await server.recordUsageBatch([
      { customer: "user_1", feature: aiCredits, amount: 1, idempotencyKey: "e1" },
      { customer: "user_2", feature: aiCredits, amount: 2, idempotencyKey: "e2" },
    ]);
    expect(result.errors).toBe(2);
    expect(result.results.map((each) => [each.outcome, each.error?.code, each.idempotencyKey])).toEqual([
      ["error", "invalid_response", "e1"],
      ["error", "invalid_response", "e2"],
    ]);
  });

  it("answers a batch chunk's events error when a result names an event it was not sent", async () => {
    const { server } = serverFor(
      json({
        results: [{ index: 5, outcome: "recorded", id: "u1", late: false, error: null }],
        recorded: 1,
        duplicates: 0,
        errors: 0,
      }),
    );
    const aiCredits = { key: "ai_credits", type: "metered", includes: [] } as const;
    const result = await server.recordUsageBatch([
      { customer: "user_1", feature: aiCredits, amount: 1, idempotencyKey: "e1" },
    ]);
    expect(result.results[0]).toMatchObject({ outcome: "error", error: { code: "invalid_response" } });
    expect(result).toMatchObject({ recorded: 0, errors: 1 });
  });
});
