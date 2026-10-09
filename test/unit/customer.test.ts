import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Check,
  defineFeature,
  Entitlements,
  EntitlerClient,
  EntitlerServer,
  type HoldContext,
  type ServerCustomer,
  UsageRefusedError,
  type UsageResult,
  UsageSettlementError,
} from "../../src/index.js";
import { apiError, checkAnswer, context, detailsAnswer, fakeFetch, json, usageAnswer } from "./fake.js";

const aiCredits = defineFeature("ai_credits", "metered");

afterEach(() => {
  vi.restoreAllMocks();
});

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  exportPdf: defineFeature("export_pdf", "boolean"),
  collaboration: defineFeature("collaboration", "group", ["team_seats", "shared_folders"]),
  supportSlaHours: defineFeature("support_sla_hours", "config"),
};

function setup(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  const server = new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false });
  return { ...fake, server, customer: server.customer("user_1") };
}

const sku = { connector: "stripe", ids: { priceId: "price_123" } };

describe("Customer requests", () => {
  it.each([
    [
      "check",
      (c: ServerCustomer) => c.check(features.exportPdf),
      "GET",
      "/customers/user_1/entitlements/export_pdf",
      undefined,
    ],
    ["entitlements", (c: ServerCustomer) => c.entitlements(), "GET", "/customers/user_1/entitlements", undefined],
    ["planSpace", (c: ServerCustomer) => c.plans(), "GET", "/customers/user_1/plans", undefined],
    ["pricing", (c: ServerCustomer) => c.pricing(), "GET", "/customers/user_1/pricing", undefined],
    ["hold", (c: ServerCustomer) => c.hold("hold_1"), "GET", "/customers/user_1/usage/holds/hold_1", undefined],
    ["snapshot", (c: ServerCustomer) => c.snapshot(), "POST", "/customers/user_1/snapshots", {}],
    [
      "snapshot with a lifetime",
      (c: ServerCustomer) => c.snapshot({ ttlSeconds: 600 }),
      "POST",
      "/customers/user_1/snapshots",
      { ttlSeconds: 600 },
    ],
    [
      "recordUsage",
      (c: ServerCustomer) => c.recordUsage(features.aiCredits, 3),
      "POST",
      "/customers/user_1/usage",
      { feature: "ai_credits", amount: 3 },
    ],
    [
      "recordUsage with options",
      (c: ServerCustomer) =>
        c.recordUsage(aiCredits, 3, {
          mode: "observe",
          occurredAt: new Date("2026-10-09T00:00:00Z"),
          register: true,
          idempotencyKey: "job-1",
        }),
      "POST",
      "/customers/user_1/usage",
      { feature: "ai_credits", amount: 3, mode: "observe", occurredAt: "2026-10-09T00:00:00.000Z", register: true },
    ],
    [
      "holdUsage",
      (c: ServerCustomer) => c.holdUsage(features.aiCredits, 50, { ttlSeconds: 60 }),
      "POST",
      "/customers/user_1/usage/holds",
      { feature: "ai_credits", amount: 50, ttlSeconds: 60 },
    ],
    [
      "settleUsage",
      (c: ServerCustomer) => c.settleUsage("hold_1", 0),
      "POST",
      "/customers/user_1/usage/holds/hold_1/settle",
      { amount: 0 },
    ],
    [
      "releaseUsage",
      (c: ServerCustomer) => c.releaseUsage("hold_1"),
      "DELETE",
      "/customers/user_1/usage/holds/hold_1",
      undefined,
    ],
  ] as const)("%s", async (_name, call, method, path, body) => {
    const { customer, sent } = setup(json(checkAnswer()));
    await call(customer as never);
    expect(sent[0]).toMatchObject({ method, path });
    expect(sent[0]?.body).toEqual(body);
    expect(sent[0]?.headers["idempotency-key"] !== undefined).toBe(method !== "GET");
  });

  it("types a check from the feature constant and adds stale", async () => {
    const { customer } = setup(
      json(
        checkAnswer({
          feature: "ai_credits",
          type: "metered",
          value: 300,
          used: 3,
          held: 0,
          remaining: 297,
          resetsAt: null,
        }),
      ),
    );
    const check: Check<"metered"> = await customer.check(features.aiCredits);
    expect(check).toMatchObject({
      used: 3,
      remaining: 297,
      resetsAt: null,
      stale: false,
      environment: context.environment,
    });
    const general: Check = await customer.check("ai_credits");
    expect(general.type).toBe("metered");
  });

  it("refuses blank arguments with the spec's messages", async () => {
    const { customer, mock } = setup(json({}));
    await expect(customer.check(" ")).rejects.toThrow(new TypeError("Name the feature by its key."));
    await expect(customer.settleUsage("", 1)).rejects.toThrow(new TypeError("Provide the id of the hold."));
    await expect(customer.vendor.revokeGrant("")).rejects.toThrow(new TypeError("Provide the id of the grant."));
    await expect(customer.vendor.cancelUsage(" ")).rejects.toThrow(
      new TypeError("Provide the id of the usage report."),
    );
    await expect(customer.subscribe(" ")).rejects.toThrow(new TypeError("Name the plan by its id or its key."));
    await expect(customer.removeAddOn("")).rejects.toThrow(new TypeError("Name the plan by its id or its key."));
    expect(mock).not.toHaveBeenCalled();
  });

  it("checks amounts are whole numbers in range", async () => {
    const { customer, mock } = setup(json({}));
    await expect(customer.recordUsage(aiCredits, 0)).rejects.toThrow(RangeError);
    await expect(customer.recordUsage(aiCredits, 1.5)).rejects.toThrow(TypeError);
    await expect(customer.recordUsage(aiCredits, 2 ** 53)).rejects.toThrow(RangeError);
    await expect(customer.recordUsage(aiCredits, "3" as never)).rejects.toThrow(TypeError);
    await expect(customer.recordUsage(aiCredits, 1, { occurredAt: "soon" })).rejects.toThrow(
      new TypeError("Pass occurredAt as a valid date."),
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("sends the visitor only when given to customer pricing", async () => {
    const { customer, sent } = setup(
      json({ ...context, customer: "user_1", defaultPlan: "free", products: [], plans: [] }),
    );
    const pricing = await customer.pricing({ visitor: "abcdefghijklmnop" });
    expect(sent[0]?.headers["entitler-visitor"]).toBe("abcdefghijklmnop");
    expect(pricing.stale).toBe(false);
    await expect(customer.pricing({ visitor: "x" })).rejects.toThrow(TypeError);
  });
});

describe("isEntitled", () => {
  it("answers Entitler's decision", async () => {
    const { customer } = setup(json(checkAnswer({ entitled: false, value: 0 })));
    expect(await customer.isEntitled(features.exportPdf, { default: true })).toBe(false);
  });

  it("answers the default and calls onError when the check fails", async () => {
    const onError = vi.fn();
    const { fetch } = fakeFetch(apiError(404, "feature_not_found"));
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    expect(await customer.isEntitled("nope", { default: false })).toBe(false);
    expect(await customer.isEntitled("nope", { default: true })).toBe(true);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "feature_not_found" });
  });

  it("answers the default when no onError is set", async () => {
    const { customer } = setup(new TypeError("offline"));
    expect(
      await new EntitlerServer({ key: "k", fetch: fakeFetch(new TypeError("x")).fetch, maxRetries: 0 })
        .customer("u")
        .isEntitled("f", { default: true }),
    ).toBe(true);
    void customer;
  });

  it("answers a stale answer's decision", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"1"', "cache-control": "no-cache" }),
      apiError(503, "unavailable"),
    );
    const customer = new EntitlerServer({ key: "k", fetch, maxRetries: 0 }).customer("u");
    await customer.check("export_pdf");
    expect(await customer.isEntitled("export_pdf", { default: false })).toBe(true);
  });

  it("throws for a blank feature or a missing default", async () => {
    const { customer } = setup(json(checkAnswer()));
    await expect(customer.isEntitled("", { default: false })).rejects.toThrow(
      new TypeError("Name the feature by its key."),
    );
    await expect(customer.isEntitled("f", {} as never)).rejects.toThrow(TypeError);
  });

  it("propagates cancellation and never passes it to onError", async () => {
    const onError = vi.fn();
    const controller = new AbortController();
    const { fetch } = fakeFetch(() => {
      controller.abort();
      throw new Error("aborted");
    });
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    const error = await customer.isEntitled("f", { default: true, signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("Entitlements", () => {
  const list = {
    customer: "user_1",
    ...context,
    asOf: "2026-10-09T01:00:00.000Z",
    entitlements: [
      { key: "export_pdf", type: "boolean", entitled: true, value: true, sources: [] },
      {
        key: "ai_credits",
        type: "metered",
        entitled: false,
        value: 300,
        sources: [],
        used: 300,
        held: 0,
        remaining: 0,
        resetsAt: "2026-11-01T00:00:00Z",
      },
      {
        key: "collaboration",
        type: "group",
        entitled: false,
        value: 0,
        sources: [{ type: "group", features: ["team_seats", "shared_folders"] }],
      },
      { key: "future", type: "brand_new", entitled: true, value: "unlimited", sources: [{ type: "mystery" }] },
    ],
  };

  it("answers get and has from the server's decisions, groups included", async () => {
    const { customer } = setup(json(list));
    const entitlements = await customer.entitlements();
    expect(entitlements).toBeInstanceOf(Entitlements);
    expect(entitlements.has(features.exportPdf)).toBe(true);
    expect(entitlements.has("ai_credits")).toBe(false);
    expect(entitlements.has(features.collaboration)).toBe(false);
    expect(entitlements.has("team_seats")).toBe(false);
    expect(entitlements.has("future")).toBe(true);
    expect(entitlements.get("ai_credits")?.resetsAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(entitlements.get("missing")).toBeUndefined();
    expect([...entitlements].map((item) => item.key)).toEqual(["export_pdf", "ai_credits", "collaboration", "future"]);
    expect(entitlements).toMatchObject({
      customer: "user_1",
      release: 2,
      change: null,
      testers: true,
      experiment: null,
      stale: false,
    });
    expect(entitlements.asOf).toEqual(new Date("2026-10-09T01:00:00.000Z"));
  });
});

describe("usage", () => {
  it.each(["recorded", "duplicate", "refused", "held", "settled", "released", "cancelled", "adjusted", "brand_new"])(
    "answers outcome %s",
    async (outcome) => {
      const { customer } = setup(
        json(usageAnswer({ outcome, refusal: outcome === "refused" ? "over_allowance" : null })),
      );
      const result = await customer.recordUsage(aiCredits, 3);
      expect(result.outcome).toBe(outcome);
      expect(result.occurredAt).toBeInstanceOf(Date);
    },
  );

  it("reads the meters and pages the usage log", async () => {
    const event = (id: string) => ({
      id,
      feature: "ai_credits",
      amount: 1,
      kind: "use",
      setTo: null,
      source: "api",
      actor: null,
      at: "2026-10-09T00:00:00Z",
      cancelledAt: null,
    });
    const { customer, sent } = setup((request) =>
      json({
        customer: "user_1",
        ...context,
        asOf: "2026-10-09T01:00:00Z",
        metersStartAgainAt: "2026-11-01T00:00:00Z",
        features: [],
        log:
          request.query.cursor === "c2"
            ? { items: [event("e3")], next: null }
            : { items: [event("e1"), event("e2")], next: "c2" },
      }),
    );
    const usage = await customer.usage();
    expect(usage.metersStartAgainAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(sent).toHaveLength(1);
    const ids: string[] = [];
    for await (const item of usage.log) {
      ids.push(item.id);
      expect(item.at).toBeInstanceOf(Date);
    }
    expect(ids).toEqual(["e1", "e2", "e3"]);
    expect(sent.map((request) => request.query.cursor)).toEqual([undefined, "c2"]);
    const pages: number[] = [];
    for await (const page of usage.log.pages()) pages.push(page.items.length);
    expect(pages).toEqual([2, 1]);
  });

  it("fetches the next page only when iteration reaches it", async () => {
    const { server, sent } = setup((request) =>
      json({
        items: [detailsAnswer().customer],
        next: request.query.cursor ? null : "c2",
        used: 1,
        limit: "unlimited",
      }),
    );
    const list = server.customers.list({ q: "acme", includeTest: true, cohort: "c1", track: "t1" });
    expect(sent).toHaveLength(0);
    for await (const customer of list) {
      expect(customer.createdAt).toBeInstanceOf(Date);
      break;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.query).toEqual({ q: "acme", includeTest: "true", cohort: "c1", track: "t1" });
    const all = [];
    for await (const customer of list) all.push(customer);
    expect(all).toHaveLength(2);
    expect(sent[2]?.query.cursor).toBe("c2");
  });

  it("sends includeTest only when true, and no other option unless given", async () => {
    const { server, sent } = setup(json({ items: [], next: null }));
    for await (const _ of server.customers.list({ includeTest: false })) void _;
    for await (const _ of server.customers.list()) void _;
    expect(sent.map((request) => request.query)).toEqual([{}, {}]);
  });
});

describe("withHold", () => {
  function holdFlow(settle: unknown = usageAnswer({ outcome: "settled" }), hold: Record<string, unknown> = {}) {
    return setup((request) => {
      if (request.path.endsWith("/usage/holds")) {
        return json(
          usageAnswer({ outcome: "held", holdId: "hold_1", amount: 500, expiresAt: "2999-01-01T00:00:00Z", ...hold }),
        );
      }
      if (request.path.endsWith("/settle")) return settle instanceof Response ? settle : json(settle);
      if (request.method === "DELETE") return json(usageAnswer({ outcome: "released" }));
      return json(usageAnswer({ mode: "observe" }));
    });
  }

  it("holds, runs the work, settles the amount it reports and answers its result", async () => {
    const { customer, sent } = holdFlow();
    const work = vi.fn(async ({ hold }: HoldContext) => {
      hold.use(200);
      hold.use(120);
      return { text: "done" };
    });
    const reply = await customer.withHold(features.aiCredits, 500, work, { idempotencyKey: "job-7", ttlSeconds: 120 });
    expect(reply).toEqual({ text: "done" });
    const context = work.mock.calls[0]?.[0];
    expect(context?.hold).toMatchObject({ id: "hold_1", amount: 500 });
    expect(context?.hold.result.outcome).toBe("held");
    expect(context?.signal).toBeInstanceOf(AbortSignal);
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/customers/user_1/usage/holds", { feature: "ai_credits", amount: 500, ttlSeconds: 120 }],
      ["POST", "/customers/user_1/usage/holds/hold_1/settle", { amount: 120 }],
    ]);
    expect(sent[0]?.headers["idempotency-key"]).toBe("job-7");
  });

  it("settles the held amount when the work reports none", async () => {
    const { customer, sent } = holdFlow();
    expect(await customer.withHold(features.aiCredits, 500, () => "ok")).toBe("ok");
    expect(sent[1]?.body).toEqual({ amount: 500 });
  });

  it("runs the work for a replay of a hold that is still open", async () => {
    const { customer, sent } = holdFlow(undefined, { outcome: "duplicate" });
    expect(await customer.withHold(features.aiCredits, 500, () => 1)).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("settles the held amount and records the excess in observe mode", async () => {
    const { customer, sent } = holdFlow();
    await customer.withHold(features.aiCredits, 500, ({ hold }) => hold.use(650), { idempotencyKey: "job-8" });
    expect(sent[1]?.body).toEqual({ amount: 500 });
    expect(sent[2]).toMatchObject({
      method: "POST",
      path: "/customers/user_1/usage",
      body: { feature: "ai_credits", amount: 150, mode: "observe" },
    });
    expect(sent[2]?.headers["idempotency-key"]).toBe("job-8:excess");
  });

  it.each([
    ["refused", { outcome: "refused", refusal: "over_allowance", holdId: null }],
    ["settled", { outcome: "settled", holdId: "hold_1" }],
    ["released", { outcome: "released", holdId: "hold_1" }],
  ])("never runs the work when the hold answers %s", async (_name, answer) => {
    const refused = usageAnswer({ amount: 500, ...answer });
    const { customer, sent } = setup(json(refused));
    const work = vi.fn(() => 1);
    const error = await customer.withHold(features.aiCredits, 500, work).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageRefusedError);
    expect((error as UsageRefusedError).result.outcome).toBe(answer.outcome);
    expect((error as UsageRefusedError).name).toBe("UsageRefusedError");
    expect(work).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it("explains each refusal", () => {
    const base = usageAnswer({ amount: 500 }) as never as UsageResult;
    expect(new UsageRefusedError({ ...base, outcome: "refused", refusal: "not_entitled" }).message).toBe(
      "The customer is not entitled to ai_credits.",
    );
    expect(new UsageRefusedError({ ...base, outcome: "refused", refusal: "over_allowance" }).message).toBe(
      "The customer has too little ai_credits left for 500.",
    );
    expect(new UsageRefusedError({ ...base, outcome: "settled" }).message).toBe(
      "This hold was already settled. Use a new idempotency key for new work.",
    );
  });

  it("releases the hold and rethrows when the work fails", async () => {
    const { customer, sent } = holdFlow();
    const failure = new Error("model crashed");
    await expect(
      customer.withHold(features.aiCredits, 500, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(sent.map((request) => request.method + request.path)).toEqual([
      "POST/customers/user_1/usage/holds",
      "DELETE/customers/user_1/usage/holds/hold_1",
    ]);
  });

  it("releases the hold outside the caller's cancellation, then propagates it", async () => {
    const { customer, sent } = holdFlow();
    const controller = new AbortController();
    const call = customer.withHold(
      features.aiCredits,
      500,
      () => {
        controller.abort();
        return new Promise(() => {});
      },
      { signal: controller.signal },
    );
    const error = await call.catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(sent.at(-1)?.method).toBe("DELETE");
  });

  it("passes a failed release to onError and still rethrows the work's error", async () => {
    const onError = vi.fn();
    const { fetch } = fakeFetch((request) =>
      request.method === "DELETE"
        ? apiError(409, "hold_expired")
        : json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5 })),
    );
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    const failure = new Error("boom");
    await expect(customer.withHold(features.aiCredits, 5, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "hold_expired" });
  });

  it("records the whole amount in observe mode when the hold expired during the work", async () => {
    const { customer, sent } = holdFlow(apiError(409, "hold_expired"));
    const reply = await customer.withHold(
      features.aiCredits,
      500,
      ({ hold }) => {
        hold.use(320);
        return "late";
      },
      { idempotencyKey: "job-9" },
    );
    expect(reply).toBe("late");
    expect(sent[2]).toMatchObject({
      path: "/customers/user_1/usage",
      body: { feature: "ai_credits", amount: 320, mode: "observe" },
    });
    expect(sent[2]?.headers["idempotency-key"]).toBe("job-9:excess");
  });

  it("refuses a replay of a hold that already expired", async () => {
    const { customer, sent } = holdFlow(undefined, { outcome: "duplicate", expiresAt: "2000-01-01T00:00:00Z" });
    await expect(customer.withHold(features.aiCredits, 500, () => 1)).rejects.toBeInstanceOf(UsageRefusedError);
    expect(sent).toHaveLength(1);
  });

  it("fails a settlement with UsageSettlementError carrying the work's result", async () => {
    const { customer } = holdFlow(apiError(422, "idempotency_mismatch"));
    const error = (await customer
      .withHold(features.aiCredits, 500, ({ hold }) => {
        hold.use(520);
        return "summary";
      })
      .catch((e: unknown) => e)) as UsageSettlementError;
    expect(error).toBeInstanceOf(UsageSettlementError);
    expect(error).toMatchObject({
      holdId: "hold_1",
      amount: 500,
      excess: 20,
      result: "summary",
      name: "UsageSettlementError",
    });
    expect((error.cause as { code: string }).code).toBe("idempotency_mismatch");
    expect(error.message).toBe("Entitler could not settle hold hold_1. Settle it again with settleUsage().");
  });

  it("fails an excess report with UsageSettlementError", async () => {
    const { fetch } = fakeFetch((request) => {
      if (request.path.endsWith("/usage/holds"))
        return json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5 }));
      if (request.path.endsWith("/settle")) return json(usageAnswer({ outcome: "settled" }));
      return apiError(400, "invalid_amount");
    });
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    const error = await customer.withHold(features.aiCredits, 5, ({ hold }) => hold.use(9)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "UsageSettlementError", excess: 4, amount: 5 });
  });

  it("refuses a reported amount that is not a whole number", async () => {
    const { customer, sent } = holdFlow();
    await expect(customer.withHold(features.aiCredits, 500, ({ hold }) => hold.use(-1))).rejects.toThrow(
      new RangeError("Pass the amount used as a whole number of 0 or more."),
    );
    expect(sent.at(-1)?.method).toBe("DELETE");
    await expect(customer.withHold(features.aiCredits, 5, "nope" as never)).rejects.toThrow(TypeError);
  });

  it("refuses a key with no room for :excess", async () => {
    const { customer, mock } = holdFlow();
    await expect(
      customer.withHold(features.aiCredits, 5, () => 1, { idempotencyKey: "k".repeat(194) }),
    ).rejects.toThrow(new TypeError("Pass idempotencyKey as 1 to 193 printable ASCII characters."));
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("batches", () => {
  it("splits inputs over 500 into ordered requests and merges the results", async () => {
    const { server, sent } = setup((request) => {
      const events = (request.body as { events: unknown[] }).events;
      return json({
        results: events.map((_, index) => ({
          index,
          outcome: index === 0 ? "duplicate" : "recorded",
          id: `u${index}`,
          late: false,
          error: null,
        })),
        recorded: events.length - 1,
        duplicates: 1,
        errors: 0,
      });
    });
    const events = Array.from({ length: 1201 }, (_, i) => ({
      customer: `c${i}`,
      feature: features.aiCredits,
      ...(i === 0 ? { amount: 4, occurredAt: "2026-10-09T00:00:00Z", idempotencyKey: "evt-0" } : {}),
    }));
    const batch = await server.recordUsageBatch(events, { register: true });
    expect(sent.map((request) => (request.body as { events: unknown[] }).events.length)).toEqual([500, 500, 201]);
    expect(sent.every((request) => request.path === "/usage/events" && request.method === "POST")).toBe(true);
    const first = sent[0]?.body as { register: boolean; events: unknown[] };
    expect(first.register).toBe(true);
    expect(first.events[0]).toEqual({
      customer: "c0",
      feature: "ai_credits",
      amount: 4,
      occurredAt: "2026-10-09T00:00:00.000Z",
      idempotencyKey: "evt-0",
    });
    expect(batch.results).toHaveLength(1201);
    expect(batch.results.map((result) => result.index)).toEqual(Array.from({ length: 1201 }, (_, i) => i));
    expect(batch.results[0]?.idempotencyKey).toBe("evt-0");
    expect(batch.results[500]?.outcome).toBe("duplicate");
    expect(batch.results[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch).toMatchObject({ recorded: 1198, duplicates: 3, errors: 0 });
    expect(new Set(sent.map((request) => request.headers["idempotency-key"])).size).toBe(3);
  });

  it("sends nothing for an empty batch and validates events", async () => {
    const { server, mock } = setup(json({}));
    expect(await server.recordUsageBatch([])).toEqual({ results: [], recorded: 0, duplicates: 0, errors: 0 });
    await expect(server.recordUsageBatch([{ customer: "", feature: "f" }])).rejects.toThrow(TypeError);
    await expect(server.recordUsageBatch("x" as never)).rejects.toThrow(TypeError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("ServerCustomer requests", () => {
  const change = { ...detailsAnswer(), selfServe: true };
  it.each([
    ["register with no details", (c: ServerCustomer) => c.register(), "PUT", "/customers/user_1", undefined, {}],
    [
      "register with details",
      (c: ServerCustomer) => c.register({ name: "Ada", email: "ada@example.com", metadata: { team: "a" } }),
      "PUT",
      "/customers/user_1",
      { name: "Ada", email: "ada@example.com", metadata: { team: "a" } },
      {},
    ],
    ["details", (c: ServerCustomer) => c.details(), "GET", "/customers/user_1", undefined, {}],
    [
      "details from a cursor",
      (c: ServerCustomer) => c.details({ cursor: "c9" }),
      "GET",
      "/customers/user_1",
      undefined,
      { cursor: "c9" },
    ],
    [
      "update",
      (c: ServerCustomer) => c.update({ name: "Ada L", metadata: { team: null, role: "admin" } }),
      "PATCH",
      "/customers/user_1",
      { name: "Ada L", metadata: { team: null, role: "admin" } },
      {},
    ],
    ["delete", (c: ServerCustomer) => c.delete(), "DELETE", "/customers/user_1", undefined, {}],
    [
      "delete with erase",
      (c: ServerCustomer) => c.delete({ erase: true }),
      "DELETE",
      "/customers/user_1",
      undefined,
      { erase: "true" },
    ],
    ["token", (c: ServerCustomer) => c.token(), "POST", "/customers/user_1/tokens", {}, {}],
    [
      "token with options",
      (c: ServerCustomer) => c.token({ scopes: ["entitlements:read"], ttlSeconds: 900 }),
      "POST",
      "/customers/user_1/tokens",
      { scopes: ["entitlements:read"], ttlSeconds: 900 },
      {},
    ],
    [
      "setTrack",
      (c: ServerCustomer) => c.setTrack("trk_beta"),
      "PUT",
      "/customers/user_1/track",
      { trackId: "trk_beta" },
      {},
    ],
    ["setTrack back", (c: ServerCustomer) => c.setTrack(null), "PUT", "/customers/user_1/track", { trackId: null }, {}],
    [
      "subscribe",
      (c: ServerCustomer) => c.subscribe("pro"),
      "POST",
      "/customers/user_1/subscription",
      { plan: "pro", selfServe: true },
      {},
    ],
    [
      "subscribe with options",
      (c: ServerCustomer) => c.subscribe("pro", { period: "yearly", when: "end" }),
      "POST",
      "/customers/user_1/subscription",
      { plan: "pro", period: "yearly", when: "end", selfServe: true },
      {},
    ],
    [
      "subscribe to a SKU",
      (c: ServerCustomer) => c.subscribe({ sku }),
      "POST",
      "/customers/user_1/subscription",
      { sku, selfServe: true },
      {},
    ],
    [
      "checkout",
      (c: ServerCustomer) =>
        c.checkout("pro", {
          period: "monthly",
          successUrl: "https://a.example/ok",
          cancelUrl: "https://a.example/no",
          connection: "con_1",
        }),
      "POST",
      "/customers/user_1/checkout",
      {
        plan: "pro",
        period: "monthly",
        successUrl: "https://a.example/ok",
        cancelUrl: "https://a.example/no",
        connection: "con_1",
        selfServe: true,
      },
      {},
    ],
    ["cancel", (c: ServerCustomer) => c.cancel(), "DELETE", "/customers/user_1/subscription", undefined, {}],
    [
      "cancel with options",
      (c: ServerCustomer) => c.cancel({ when: "now", product: "core" }),
      "DELETE",
      "/customers/user_1/subscription",
      undefined,
      { when: "now", product: "core" },
    ],
    [
      "undoPendingChange",
      (c: ServerCustomer) => c.undoPendingChange({ product: "core" }),
      "DELETE",
      "/customers/user_1/subscription/pending",
      undefined,
      { product: "core" },
    ],
    [
      "addAddOn",
      (c: ServerCustomer) => c.addAddOn("sso_addon"),
      "POST",
      "/customers/user_1/subscription/add-ons",
      { plan: "sso_addon", selfServe: true },
      {},
    ],
    [
      "addAddOn with options",
      (c: ServerCustomer) => c.addAddOn({ sku }, { quantity: 2, replaces: "support_standard", when: "now" }),
      "POST",
      "/customers/user_1/subscription/add-ons",
      { sku, quantity: 2, replaces: "support_standard", when: "now", selfServe: true },
      {},
    ],
    [
      "setAddOnQuantity",
      (c: ServerCustomer) => c.setAddOnQuantity("seats", 3),
      "PATCH",
      "/customers/user_1/subscription/add-ons/seats",
      { quantity: 3, selfServe: true },
      {},
    ],
    [
      "removeAddOn",
      (c: ServerCustomer) => c.removeAddOn("sso_addon"),
      "DELETE",
      "/customers/user_1/subscription/add-ons/sso_addon",
      undefined,
      {},
    ],
    [
      "undoAddOnChange",
      (c: ServerCustomer) => c.undoAddOnChange("sso_addon"),
      "DELETE",
      "/customers/user_1/subscription/add-ons/sso_addon/pending",
      undefined,
      {},
    ],
    ["billing", (c: ServerCustomer) => c.billing(), "GET", "/customers/user_1/billing", undefined, {}],
    [
      "billingPortal",
      (c: ServerCustomer) => c.billingPortal({ returnUrl: "https://a.example/account" }),
      "POST",
      "/customers/user_1/billing-portal",
      { returnUrl: "https://a.example/account" },
      {},
    ],
    ["providers", (c: ServerCustomer) => c.providers(), "GET", "/customers/user_1/providers", undefined, {}],
    [
      "vendor.subscribe",
      (c: ServerCustomer) => c.vendor.subscribe("team"),
      "POST",
      "/customers/user_1/subscription",
      { plan: "team", selfServe: false },
      {},
    ],
    [
      "vendor.subscribe to a SKU",
      (c: ServerCustomer) => c.vendor.subscribe({ sku }),
      "POST",
      "/customers/user_1/subscription",
      { sku, selfServe: false },
      {},
    ],
    [
      "vendor.override",
      (c: ServerCustomer) => c.vendor.override("team", { period: "Monthly" }),
      "POST",
      "/customers/user_1/subscription",
      { plan: "team", period: "Monthly", selfServe: false, override: true },
      {},
    ],
    [
      "vendor.undoOverride",
      (c: ServerCustomer) => c.vendor.undoOverride(),
      "DELETE",
      "/customers/user_1/subscription/override",
      undefined,
      {},
    ],
    [
      "vendor.checkout",
      (c: ServerCustomer) =>
        c.vendor.checkout({ sku }, { successUrl: "https://a.example/ok", cancelUrl: "https://a.example/no" }),
      "POST",
      "/customers/user_1/checkout",
      { sku, successUrl: "https://a.example/ok", cancelUrl: "https://a.example/no", selfServe: false },
      {},
    ],
    [
      "vendor.addAddOn",
      (c: ServerCustomer) => c.vendor.addAddOn("sso_addon"),
      "POST",
      "/customers/user_1/subscription/add-ons",
      { plan: "sso_addon", selfServe: false },
      {},
    ],
    [
      "vendor.setAddOnQuantity",
      (c: ServerCustomer) => c.vendor.setAddOnQuantity("seats", 5),
      "PATCH",
      "/customers/user_1/subscription/add-ons/seats",
      { quantity: 5, selfServe: false },
      {},
    ],
    [
      "vendor.grant",
      (c: ServerCustomer) => c.vendor.grant(features.exportPdf),
      "POST",
      "/customers/user_1/grants",
      { feature: "export_pdf" },
      {},
    ],
    [
      "vendor.grant with options",
      (c: ServerCustomer) => c.vendor.grant("ai_credits", { value: 500, days: 30, reason: "Pilot" }),
      "POST",
      "/customers/user_1/grants",
      { feature: "ai_credits", value: "500", days: 30, reason: "Pilot" },
      {},
    ],
    [
      "vendor.grant unlimited",
      (c: ServerCustomer) => c.vendor.grant("ai_credits", { value: "unlimited" }),
      "POST",
      "/customers/user_1/grants",
      { feature: "ai_credits", value: "unlimited" },
      {},
    ],
    [
      "vendor.revokeGrant",
      (c: ServerCustomer) => c.vendor.revokeGrant("gr_1"),
      "DELETE",
      "/customers/user_1/grants/gr_1",
      undefined,
      {},
    ],
    [
      "vendor.setMeter",
      (c: ServerCustomer) => c.vendor.setMeter(features.aiCredits, 0),
      "PUT",
      "/customers/user_1/meters/ai_credits",
      { used: 0 },
      {},
    ],
    [
      "vendor.cancelUsage",
      (c: ServerCustomer) => c.vendor.cancelUsage("use_1"),
      "DELETE",
      "/customers/user_1/usage/use_1",
      undefined,
      {},
    ],
  ] as const)("%s", async (_name, call, method, path, body, query) => {
    const { customer, sent } = setup(json(change));
    await call(customer as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method, path, query });
    expect(sent[0]?.body).toEqual(body);
    expect(sent[0]?.headers["idempotency-key"] !== undefined).toBe(method !== "GET");
    expect(sent[0]?.headers["content-type"] !== undefined).toBe(body !== undefined);
  });

  it("validates billing options", async () => {
    const { customer, mock } = setup(json({}));
    await expect(customer.checkout("pro", { successUrl: "", cancelUrl: "x" })).rejects.toThrow(TypeError);
    await expect(customer.checkout("pro", { successUrl: "x", cancelUrl: " " })).rejects.toThrow(TypeError);
    await expect(customer.billingPortal({ returnUrl: "" })).rejects.toThrow(TypeError);
    await expect(customer.subscribe({ sku: null } as never)).rejects.toThrow(TypeError);
    await expect(customer.setAddOnQuantity("seats", 0)).rejects.toThrow(RangeError);
    await expect(customer.vendor.grant("f", { value: -1 })).rejects.toThrow(RangeError);
    await expect(customer.setTrack(" ")).rejects.toThrow(TypeError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("decodes details with the usage log as pages", async () => {
    const event = {
      id: "e2",
      feature: "f",
      amount: 1,
      kind: "use",
      setTo: null,
      source: "api",
      actor: null,
      at: "2026-10-09T00:00:00Z",
      cancelledAt: null,
    };
    const { customer, sent } = setup((request) =>
      json(
        detailsAnswer({
          usage: request.query.cursor
            ? { items: [event], next: null }
            : { items: [{ ...event, id: "e1" }], next: "c2" },
          grants: [
            {
              id: "g",
              feature: "f",
              value: "",
              from: "2026-10-01T00:00:00Z",
              until: null,
              revokedAt: null,
              reason: "",
              by: "api",
            },
          ],
        }),
      ),
    );
    const details = await customer.details();
    expect(details.customer.createdAt).toBeInstanceOf(Date);
    expect(details.grants[0]?.from).toBeInstanceOf(Date);
    const ids = [];
    for await (const item of details.usage) ids.push(item.id);
    expect(ids).toEqual(["e1", "e2"]);
    expect(sent[1]?.query.cursor).toBe("c2");
  });

  it("creates a customer", async () => {
    const { server, sent } = setup(json(detailsAnswer(), 201));
    const details = await server.customers.create(
      { externalId: "user_1", name: "Ada", plan: "pro", period: "monthly" },
      { idempotencyKey: "create-1" },
    );
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/customers",
      body: { externalId: "user_1", name: "Ada", plan: "pro", period: "monthly" },
    });
    expect(sent[0]?.headers["idempotency-key"]).toBe("create-1");
    const items = [];
    for await (const item of details.usage) items.push(item);
    expect(items).toEqual([]);
    await expect(server.customers.create({ externalId: "", name: "x" })).rejects.toThrow(TypeError);
    await expect(server.customers.create({ externalId: "a", name: "" })).rejects.toThrow(TypeError);
  });
});

describe("server reads", () => {
  it("reads pricing, features and snapshot keys", async () => {
    const { server, sent } = setup((request) =>
      json(
        request.path === "/pricing/features"
          ? {
              ...context,
              features: [
                {
                  id: "f",
                  key: "f",
                  name: "F",
                  type: "boolean",
                  description: "",
                  unit: "",
                  resetEvery: null,
                  archived: false,
                  includes: [],
                },
              ],
            }
          : request.path === "/customers/snapshot-keys"
            ? { keys: [] }
            : { ...context, customer: null, defaultPlan: "free", products: [], plans: [] },
      ),
    );
    expect((await server.pricing()).defaultPlan).toBe("free");
    expect((await server.features()).features[0]?.key).toBe("f");
    expect(await server.snapshotKeys()).toEqual({ keys: [] });
    expect(sent.map((request) => request.path)).toEqual(["/pricing", "/pricing/features", "/customers/snapshot-keys"]);
  });
});

describe("the in-app customer", () => {
  it("records usage for me", async () => {
    const { fetch, sent } = fakeFetch(json(usageAnswer()));
    const client = new EntitlerClient({ token: "t", fetch });
    await client.me.recordUsage(features.aiCredits, 2);
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/customers/me/usage",
      body: { feature: "ai_credits", amount: 2 },
    });
    expect(client.me.id).toBe("user_1");
  });

  it("has no server-only methods", () => {
    const client = new EntitlerClient({ token: "t" });
    expect("register" in client.me).toBe(false);
    expect("vendor" in client.me).toBe(false);
  });
});
