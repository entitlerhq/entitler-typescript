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
      json({ items: [{ ...summary, metadata }], next: null, used: 1, limit: 1000 }),
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

  it("answers invalid_response for a customer page with no limit, or billing with no products", async () => {
    const { server } = serverFor(
      json({ items: [], next: null, used: 0, limit: null }),
      json({ provider: null, status: null, sku: null, items: 0, drift: null }),
    );
    const list = async () => {
      for await (const _ of server.customers.list()) break;
    };
    await expect(list()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(server.customer("user_1").billing()).rejects.toMatchObject({ code: "invalid_response" });
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

describe("answers match the API's schemas", () => {
  const event = {
    id: "use_1",
    feature: "ai_credits",
    amount: 2,
    kind: "adjust",
    setTo: 5,
    source: "dashboard",
    by: "Ada Lovelace",
    actor: "support",
    reason: "Refund for an outage.",
    at: "2026-10-09T00:00:00.000Z",
    cancelledAt: null,
  };

  it("decodes a usage event's by, actor and reason, and refuses one without them", async () => {
    const { server } = serverFor(json(detailsAnswer({ usage: { items: [event], next: null } })));
    const details = await server.customer("user_1").details();
    expect(details.usage.items[0]).toMatchObject({
      by: "Ada Lovelace",
      actor: "support",
      reason: "Refund for an outage.",
    });
    for (const field of ["by", "actor", "reason"]) {
      const { [field]: _, ...without } = event as Record<string, unknown>;
      const { server: other } = serverFor(json(detailsAnswer({ usage: { items: [without], next: null } })));
      await expect(other.customer("user_1").details()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("decodes an activity entry's by, actor and reason", async () => {
    const activity = {
      text: "Moved to Pro.",
      at: "2026-10-09T00:00:00.000Z",
      by: "Server key",
      actor: null,
      reason: null,
    };
    const { server } = serverFor(
      json(detailsAnswer({ activity: [activity] })),
      json(detailsAnswer({ activity: [{ text: "x", at: activity.at }] })),
    );
    expect((await server.customer("user_1").details()).activity[0]).toMatchObject({ by: "Server key", actor: null });
    await expect(server.customer("user_1").details()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("decodes the track's environmentId, and refuses a track without it", async () => {
    const track = {
      customer: "user_1",
      environmentId: "env_1",
      track: context.track,
      source: "server",
      previousTrackId: null,
    };
    const { environmentId: _, ...without } = track;
    const { server } = serverFor(json(track), json(without));
    expect((await server.customer("user_1").setTrack("Beta")).environmentId).toBe("env_1");
    await expect(server.customer("user_1").setTrack("Beta")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses an entitlement list whose entitlements lack upgrades or sources", async () => {
    const item = { key: "sso", type: "boolean", entitled: true, value: true, sources: [], upgrades: [] };
    for (const field of ["upgrades", "sources"]) {
      const { [field]: _, ...without } = item as Record<string, unknown>;
      const { server } = serverFor(
        json({ customer: "user_1", asOf: "2026-10-09T00:00:00.000Z", ...context, entitlements: [without] }),
      );
      await expect(server.customer("user_1").entitlements()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
});
