import { createHash } from "node:crypto";
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
  UsageReplayedError,
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

const sku = { connector: "apple", ids: { productId: "pro.monthly" } };
const planChange = {
  product: null,
  plan: { id: "pln_pro", key: "pro", name: "Pro", kind: "plan" },
  quantity: null,
  effective: "now",
  at: "2026-10-09T00:00:00Z",
  until: null,
  changed: true,
};

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
    ["plans", (c: ServerCustomer) => c.plans(), "GET", "/customers/user_1/plans", undefined],
    ["pricing", (c: ServerCustomer) => c.pricing(), "GET", "/customers/user_1/pricing", undefined],
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
      (c: ServerCustomer) => c.recordUsage(features.aiCredits, 3, { idempotencyKey: "msg-1" }),
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
      (c: ServerCustomer) => c.holdUsage(features.aiCredits, 50, { ttlSeconds: 60, idempotencyKey: "msg-1" }),
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
    await expect(customer.revokeGrant("")).rejects.toThrow(new TypeError("Provide the id of the grant."));
    await expect(customer.cancelUsage(" ")).rejects.toThrow(new TypeError("Provide the id of the usage report."));
    await expect(customer.subscribe(" ")).rejects.toThrow(new TypeError("Name the plan by its id or its key."));
    await expect(customer.cancel({ addOn: "" })).rejects.toThrow(new TypeError("Name the plan by its id or its key."));
    await expect(customer.setTrack(" ")).rejects.toThrow(new TypeError("Name the track by its name."));
    expect(mock).not.toHaveBeenCalled();
  });

  it("checks amounts are whole numbers in range", async () => {
    const { customer, mock } = setup(json({}));
    await expect(customer.recordUsage(aiCredits, 0, { idempotencyKey: "k" })).rejects.toThrow(RangeError);
    await expect(customer.recordUsage(aiCredits, 1.5, { idempotencyKey: "k" })).rejects.toThrow(TypeError);
    await expect(customer.recordUsage(aiCredits, 2 ** 53, { idempotencyKey: "k" })).rejects.toThrow(RangeError);
    await expect(customer.recordUsage(aiCredits, "3" as never, { idempotencyKey: "k" })).rejects.toThrow(TypeError);
    await expect(customer.recordUsage(aiCredits, 1, { occurredAt: "soon", idempotencyKey: "k" })).rejects.toThrow(
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
      const result = await customer.recordUsage(aiCredits, 3, { idempotencyKey: "k" });
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

describe("holds", () => {
  const key = { idempotencyKey: "job-7" };
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
  const paths = (sent: { method: string; path: string }[]) => sent.map((request) => request.method + request.path);

  it("answers a handle for a hold, and finishes with the amount reported", async () => {
    const { customer, sent } = holdFlow();
    const hold = await customer.startHold(features.aiCredits, 500, { ...key, ttlSeconds: 120 });
    expect(hold).toMatchObject({ id: "hold_1", amount: 500, duplicate: false });
    expect(hold.expiresAt).toEqual(new Date("2999-01-01T00:00:00Z"));
    expect(hold.result.outcome).toBe("held");
    hold.use(200);
    hold.use(120);
    expect((await hold.finish()).outcome).toBe("settled");
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/customers/user_1/usage/holds", { feature: "ai_credits", amount: 500, ttlSeconds: 120 }],
      ["POST", "/customers/user_1/usage/holds/hold_1/settle", { amount: 120 }],
    ]);
    expect(sent[0]?.headers["idempotency-key"]).toBe("job-7");
  });

  it("finishes with the held amount when none is reported, and 0 after use(0)", async () => {
    const { customer, sent } = holdFlow();
    await (await customer.startHold(features.aiCredits, 500, key)).finish();
    const streamed = await customer.startHold(features.aiCredits, 500, key);
    streamed.use(0);
    await streamed.finish();
    expect(sent.filter((request) => request.path.endsWith("/settle")).map((request) => request.body)).toEqual([
      { amount: 500 },
      { amount: 0 },
    ]);
  });

  it("answers a handle for an open duplicate, with duplicate true", async () => {
    const { customer } = holdFlow(undefined, { outcome: "duplicate" });
    expect((await customer.startHold(features.aiCredits, 500, key)).duplicate).toBe(true);
  });

  it("acts only on the first of finish, release and disposal", async () => {
    const { customer, sent } = holdFlow();
    const hold = await customer.startHold(features.aiCredits, 500, key);
    const released = await hold.release();
    expect(released.outcome).toBe("released");
    expect(await hold.finish()).toBe(released);
    await hold[Symbol.asyncDispose]();
    expect(paths(sent)).toEqual(["POST/customers/user_1/usage/holds", "DELETE/customers/user_1/usage/holds/hold_1"]);
  });

  it("disposes by settling the amount reported, else by releasing", async () => {
    const { customer, sent } = holdFlow();
    {
      await using hold = await customer.startHold(features.aiCredits, 500, key);
      hold.use(40);
    }
    {
      await using _hold = await customer.startHold(features.aiCredits, 500, key);
    }
    expect(paths(sent).slice(1)).toEqual([
      "POST/customers/user_1/usage/holds/hold_1/settle",
      "POST/customers/user_1/usage/holds",
      "DELETE/customers/user_1/usage/holds/hold_1",
    ]);
    expect(sent[1]?.body).toEqual({ amount: 40 });
  });

  it("passes a failed disposal to onError as a UsageSettlementError, and never throws", async () => {
    const onError = vi.fn();
    const { fetch } = fakeFetch((request) =>
      request.path.endsWith("/settle")
        ? apiError(422, "idempotency_mismatch")
        : json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5, expiresAt: "2999-01-01T00:00:00Z" })),
    );
    const customer = new EntitlerServer({ key: "k", fetch, onError, maxRetries: 0 }).customer("u");
    const hold = await customer.startHold(features.aiCredits, 5, key);
    hold.use(3);
    await expect(hold[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(UsageSettlementError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ holdId: "hold_1", amount: 3, result: undefined });
  });

  it("fails finish with UsageSettlementError", async () => {
    const { customer } = holdFlow(apiError(422, "idempotency_mismatch"));
    const hold = await customer.startHold(features.aiCredits, 500, key);
    hold.use(520);
    const error = (await hold.finish().catch((e: unknown) => e)) as UsageSettlementError;
    expect(error).toMatchObject({ name: "UsageSettlementError", holdId: "hold_1", amount: 500, excess: 20 });
    expect(error.message).toBe("Entitler could not settle hold hold_1. Settle it again with settleUsage().");
  });

  it("refuses a hold with UsageRefusedError, carrying the answer", async () => {
    const { customer, sent } = setup(json(usageAnswer({ amount: 500, outcome: "refused", refusal: "over_allowance" })));
    const error = await customer.startHold(features.aiCredits, 500, key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageRefusedError);
    expect(error).toMatchObject({ name: "UsageRefusedError", result: { refusal: "over_allowance" } });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["settled", { outcome: "settled", holdId: "hold_1" }],
    ["released", { outcome: "released", holdId: "hold_1" }],
    ["expired", { outcome: "duplicate", holdId: "hold_1", expiresAt: "2000-01-01T00:00:00Z" }],
  ])("refuses a key that replays a %s hold with UsageReplayedError", async (_name, answer) => {
    const { customer } = setup(json(usageAnswer({ amount: 500, ...answer })));
    const error = await customer.startHold(features.aiCredits, 500, key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageReplayedError);
    expect(error).toMatchObject({
      name: "UsageReplayedError",
      message: "This idempotency key's hold was already settled, released or expired. Use a new key for new work.",
    });
  });

  it("explains each refusal", () => {
    const base = usageAnswer({ amount: 500 }) as never as UsageResult;
    expect(new UsageRefusedError({ ...base, outcome: "refused", refusal: "not_entitled" }).message).toBe(
      "The customer is not entitled to ai_credits.",
    );
    expect(new UsageRefusedError({ ...base, outcome: "refused", refusal: "over_allowance" }).message).toBe(
      "The customer has too little ai_credits left for 500.",
    );
  });

  it("refuses a hold, a report or a handle without a key before any request", async () => {
    const { customer, mock } = holdFlow();
    const loose = customer as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const message = "Pass idempotencyKey: a key from your own unit of work, such as a message or job id.";
    for (const call of [
      () => loose.recordUsage?.(features.aiCredits, 1),
      () => loose.holdUsage?.(features.aiCredits, 1, {}),
      () => loose.startHold?.(features.aiCredits, 1),
      () => loose.withHold?.(features.aiCredits, 1, () => 1, {}),
    ]) {
      await expect(call()).rejects.toThrow(new TypeError(message));
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses a key with no room for :excess", async () => {
    const { customer, mock } = holdFlow();
    for (const call of [
      () => customer.withHold(features.aiCredits, 5, () => 1, { idempotencyKey: "k".repeat(194) }),
      () => customer.startHold(features.aiCredits, 5, { idempotencyKey: "k".repeat(194) }),
    ]) {
      await expect(call()).rejects.toThrow(
        new TypeError("Pass idempotencyKey as 1 to 193 printable ASCII characters."),
      );
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("records the excess, and the whole amount once the hold expired, under :excess", async () => {
    const { customer, sent } = holdFlow();
    await customer.withHold(features.aiCredits, 500, ({ hold }) => hold.use(650), { idempotencyKey: "job-8" });
    expect(sent[1]?.body).toEqual({ amount: 500 });
    expect(sent[2]).toMatchObject({ path: "/customers/user_1/usage", body: { amount: 150, mode: "observe" } });
    expect(sent[2]?.headers["idempotency-key"]).toBe("job-8:excess");
    const expired = holdFlow(apiError(409, "hold_expired"));
    const hold = await expired.customer.startHold(features.aiCredits, 500, { idempotencyKey: "job-9" });
    hold.use(320);
    expect((await hold.finish()).mode).toBe("observe");
    expect(expired.sent[2]).toMatchObject({ body: { feature: "ai_credits", amount: 320, mode: "observe" } });
    expect(expired.sent[2]?.headers["idempotency-key"]).toBe("job-9:excess");
  });

  it("refuses a reported amount that is not a whole number", async () => {
    const { customer } = holdFlow();
    const hold = await customer.startHold(features.aiCredits, 500, key);
    expect(() => hold.use(-1)).toThrow(new RangeError("Pass the amount used as a whole number of 0 or more."));
  });
});

describe("withHold", () => {
  const key = { idempotencyKey: "job-7" };
  function holdFlow(settle: unknown = usageAnswer({ outcome: "settled" })) {
    return setup((request) => {
      if (request.path.endsWith("/usage/holds")) {
        return json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 500, expiresAt: "2999-01-01T00:00:00Z" }));
      }
      if (request.path.endsWith("/settle")) return settle instanceof Response ? settle : json(settle);
      if (request.method === "DELETE") return json(usageAnswer({ outcome: "released" }));
      return json(usageAnswer({ mode: "observe" }));
    });
  }

  it("runs the work with the hold and its signal, finishes, and answers the work's result", async () => {
    const { customer, sent } = holdFlow();
    const work = vi.fn(async ({ hold }: HoldContext) => {
      hold.use(120);
      return { text: "done" };
    });
    expect(await customer.withHold(features.aiCredits, 500, work, key)).toEqual({ text: "done" });
    expect(work.mock.calls[0]?.[0].hold).toMatchObject({ id: "hold_1", amount: 500, duplicate: false });
    expect(work.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(sent[1]?.body).toEqual({ amount: 120 });
  });

  it("releases when the work fails before reporting, and settles what it reported after", async () => {
    const before = holdFlow();
    const failure = new Error("model crashed");
    await expect(before.customer.withHold(features.aiCredits, 500, () => Promise.reject(failure), key)).rejects.toBe(
      failure,
    );
    expect(before.sent.at(-1)?.method).toBe("DELETE");
    const after = holdFlow();
    await expect(
      after.customer.withHold(
        features.aiCredits,
        500,
        ({ hold }) => {
          hold.use(300);
          throw failure;
        },
        key,
      ),
    ).rejects.toBe(failure);
    expect(after.sent.at(-1)).toMatchObject({
      path: "/customers/user_1/usage/holds/hold_1/settle",
      body: { amount: 300 },
    });
  });

  it("disposes of the hold outside the caller's cancellation, then propagates it", async () => {
    const { customer, sent } = holdFlow();
    const controller = new AbortController();
    const call = customer.withHold(
      features.aiCredits,
      500,
      ({ hold }) => {
        hold.use(30);
        controller.abort();
        return new Promise(() => {});
      },
      { ...key, signal: controller.signal },
    );
    expect(await call.catch((e: unknown) => e)).toBe(controller.signal.reason);
    expect(sent.at(-1)).toMatchObject({ path: "/customers/user_1/usage/holds/hold_1/settle", body: { amount: 30 } });
  });

  it("passes a failed release to onError and still rethrows the work's error", async () => {
    const onError = vi.fn();
    const { fetch } = fakeFetch((request) =>
      request.method === "DELETE"
        ? apiError(409, "hold_expired")
        : json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5, expiresAt: "2999-01-01T00:00:00Z" })),
    );
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    const failure = new Error("boom");
    await expect(customer.withHold(features.aiCredits, 5, () => Promise.reject(failure), key)).rejects.toBe(failure);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "hold_expired" });
  });

  it("fails a settlement with UsageSettlementError carrying the work's result", async () => {
    const { customer } = holdFlow(apiError(422, "idempotency_mismatch"));
    const error = (await customer
      .withHold(
        features.aiCredits,
        500,
        ({ hold }) => {
          hold.use(520);
          return "summary";
        },
        key,
      )
      .catch((e: unknown) => e)) as UsageSettlementError;
    expect(error).toBeInstanceOf(UsageSettlementError);
    expect(error).toMatchObject({ holdId: "hold_1", amount: 500, excess: 20, result: "summary" });
    expect((error.cause as { code: string }).code).toBe("idempotency_mismatch");
  });

  it("refuses work that is not a function", async () => {
    const { customer, mock } = holdFlow();
    await expect(customer.withHold(features.aiCredits, 5, "nope" as never, key)).rejects.toThrow(TypeError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("batches", () => {
  function answering() {
    return setup((request) => {
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
  }
  const event = (i: number) => ({ customer: `c${i}`, feature: features.aiCredits, amount: 1, idempotencyKey: `e${i}` });

  it("splits inputs over 500 into ordered requests and merges the results", async () => {
    const { server, sent } = answering();
    const events = Array.from({ length: 1201 }, (_, i) =>
      i === 0 ? { ...event(0), amount: 4, occurredAt: "2026-10-09T00:00:00Z" } : event(i),
    );
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
      idempotencyKey: "e0",
    });
    expect(batch.results.map((result) => result.index)).toEqual(Array.from({ length: 1201 }, (_, i) => i));
    expect(batch.results[0]).toMatchObject({ idempotencyKey: "e0", replayed: false });
    expect(batch.results[500]?.outcome).toBe("duplicate");
    expect(batch).toMatchObject({ recorded: 1198, duplicates: 3, errors: 0 });
    expect(new Set(sent.map((request) => request.headers["idempotency-key"])).size).toBe(3);
  });

  it("derives each request's key from its events", async () => {
    const { server, sent } = answering();
    const events = [event(1), event(2)];
    await server.recordUsageBatch(events);
    await server.recordUsageBatch(events);
    await server.recordUsageBatch([event(2)]);
    await server.recordUsageBatch(events, { register: true });
    const keys = sent.map((request) => request.headers["idempotency-key"]);
    const rows = JSON.stringify([
      "entitler-batch-v1",
      false,
      [
        ["c1", "ai_credits", 1, null, "e1"],
        ["c2", "ai_credits", 1, null, "e2"],
      ],
    ]);
    const digest = createHash("sha256").update(rows).digest("hex");
    expect(keys[0]).toBe(`batch:${digest}`);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("answers invalid events error without sending them, and sends the rest", async () => {
    const { server, sent } = answering();
    const batch = await server.recordUsageBatch([
      event(0),
      { ...event(1), customer: " " },
      { ...event(2), amount: 0 },
      { ...event(3), idempotencyKey: undefined as never },
      { ...event(4), idempotencyKey: "bad key " },
      { ...event(5), feature: "" as never },
    ]);
    expect((sent[0]?.body as { events: unknown[] } | undefined)?.events).toHaveLength(1);
    expect(batch.results.map((result) => [result.outcome, result.error?.code])).toEqual([
      ["duplicate", undefined],
      ["error", "invalid_body"],
      ["error", "invalid_amount"],
      ["error", "invalid_idempotency_key"],
      ["error", "invalid_idempotency_key"],
      ["error", "invalid_body"],
    ]);
    expect(batch.results[3]).toMatchObject({
      idempotencyKey: null,
      error: { message: "Pass idempotencyKey: a key from your own unit of work, such as a message or job id." },
    });
    expect(batch.results[2]?.error?.message).toBe("Pass amount as a whole number from 1 to 9007199254740991.");
    expect(batch.errors).toBe(5);
  });

  it("sends nothing when nothing is left to send", async () => {
    const { server, mock } = setup(json({}));
    expect(await server.recordUsageBatch([])).toEqual({ results: [], recorded: 0, duplicates: 0, errors: 0 });
    expect((await server.recordUsageBatch([{ ...event(0), customer: "" }])).errors).toBe(1);
    await expect(server.recordUsageBatch("x" as never)).rejects.toThrow(TypeError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("answers replayed from its request", async () => {
    const { server } = setup(
      json(
        {
          results: [{ index: 0, outcome: "duplicate", id: "u0", late: false, error: null }],
          recorded: 0,
          duplicates: 1,
          errors: 0,
        },
        200,
        { "idempotent-replayed": "true" },
      ),
    );
    expect((await server.recordUsageBatch([event(0)])).results[0]?.replayed).toBe(true);
  });
});

describe("ServerCustomer requests", () => {
  const who = { reason: "Deal won", actor: "hubspot" };
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
    ["erase", (c: ServerCustomer) => c.erase(), "DELETE", "/customers/user_1", undefined, { erase: "true" }],
    ["token", (c: ServerCustomer) => c.token(), "POST", "/customers/user_1/tokens", {}, {}],
    [
      "token with options",
      (c: ServerCustomer) => c.token({ scopes: ["usage:write", "billing:self"], ttlSeconds: 900 }),
      "POST",
      "/customers/user_1/tokens",
      { scopes: ["usage:write", "billing:self"], ttlSeconds: 900 },
      {},
    ],
    ["setTrack", (c: ServerCustomer) => c.setTrack("Beta"), "PUT", "/customers/user_1/track", { track: "Beta" }, {}],
    ["setTrack back", (c: ServerCustomer) => c.setTrack(null), "PUT", "/customers/user_1/track", { track: null }, {}],
    [
      "subscribe",
      (c: ServerCustomer) => c.subscribe("pro"),
      "POST",
      "/customers/user_1/subscription",
      { plan: "pro" },
      {},
    ],
    [
      "subscribe with options",
      (c: ServerCustomer) =>
        c.subscribe("seats", { period: "yearly", quantity: 3, returnUrl: "https://a.example/back", register: true }),
      "POST",
      "/customers/user_1/subscription",
      { plan: "seats", period: "yearly", quantity: 3, returnUrl: "https://a.example/back", register: true },
      {},
    ],
    ["cancel", (c: ServerCustomer) => c.cancel(), "DELETE", "/customers/user_1/subscription", undefined, {}],
    [
      "cancel a product",
      (c: ServerCustomer) => c.cancel({ product: "core" }),
      "DELETE",
      "/customers/user_1/subscription",
      undefined,
      { product: "core" },
    ],
    [
      "cancel an add-on",
      (c: ServerCustomer) => c.cancel({ addOn: "sso_addon" }),
      "DELETE",
      "/customers/user_1/subscription/add-ons/sso_addon",
      undefined,
      {},
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
      "undoPendingChange on an add-on",
      (c: ServerCustomer) => c.undoPendingChange({ addOn: "sso_addon" }),
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
    ["syncBilling", (c: ServerCustomer) => c.syncBilling(), "POST", "/customers/user_1/billing/sync", undefined, {}],
    [
      "setPlan",
      (c: ServerCustomer) => c.setPlan("pro_basic"),
      "PUT",
      "/customers/user_1/plan",
      { plan: "pro_basic" },
      {},
    ],
    [
      "setPlan with options",
      (c: ServerCustomer) =>
        c.setPlan("enterprise", { period: "yearly", when: "end", billing: "end", register: true, ...who }),
      "PUT",
      "/customers/user_1/plan",
      { plan: "enterprise", period: "yearly", when: "end", billing: "end", register: true, ...who },
      {},
    ],
    [
      "setPlan to a SKU until its expiry",
      (c: ServerCustomer) => c.setPlan({ sku }, { until: "2026-11-09T10:00:00+10:00", billing: "keep" }),
      "PUT",
      "/customers/user_1/plan",
      { sku, billing: "keep", until: "2026-11-09T00:00:00.000Z" },
      {},
    ],
    [
      "setAddOn",
      (c: ServerCustomer) => c.setAddOn("support_standard", { quantity: 0, when: "now", ...who }),
      "PUT",
      "/customers/user_1/add-ons/support_standard",
      { quantity: 0, when: "now", ...who },
      {},
    ],
    [
      "grant",
      (c: ServerCustomer) => c.grant(features.exportPdf),
      "POST",
      "/customers/user_1/grants",
      { feature: "export_pdf" },
      {},
    ],
    [
      "grant with options",
      (c: ServerCustomer) => c.grant("ai_credits", { value: 500, days: 30, ...who }),
      "POST",
      "/customers/user_1/grants",
      { feature: "ai_credits", value: "500", days: 30, ...who },
      {},
    ],
    [
      "grant unlimited",
      (c: ServerCustomer) => c.grant("ai_credits", { value: "unlimited" }),
      "POST",
      "/customers/user_1/grants",
      { feature: "ai_credits", value: "unlimited" },
      {},
    ],
    [
      "revokeGrant",
      (c: ServerCustomer) => c.revokeGrant("gr_1"),
      "DELETE",
      "/customers/user_1/grants/gr_1",
      undefined,
      {},
    ],
    [
      "revokeGrant with who",
      (c: ServerCustomer) => c.revokeGrant("gr_1", who),
      "DELETE",
      "/customers/user_1/grants/gr_1",
      who,
      {},
    ],
    [
      "adjustMeter by",
      (c: ServerCustomer) => c.adjustMeter(features.aiCredits, { by: -500, idempotencyKey: "ticket-9", ...who }),
      "POST",
      "/customers/user_1/meters/ai_credits/adjustments",
      { by: -500, ...who },
      {},
    ],
    [
      "adjustMeter to",
      (c: ServerCustomer) => c.adjustMeter(features.aiCredits, { to: 0, idempotencyKey: "ticket-9" }),
      "POST",
      "/customers/user_1/meters/ai_credits/adjustments",
      { to: 0 },
      {},
    ],
    [
      "cancelUsage",
      (c: ServerCustomer) => c.cancelUsage("use_1"),
      "DELETE",
      "/customers/user_1/usage/use_1",
      undefined,
      {},
    ],
  ] as const)("%s", async (_name, call, method, path, body, query) => {
    const { customer, sent } = setup((request) =>
      json(
        request.method === "GET" && request.path === "/customers/user_1"
          ? detailsAnswer()
          : { next: "done", ...planChange },
      ),
    );
    await call(customer as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method, path, query });
    expect(sent[0]?.body).toEqual(body);
    expect(sent[0]?.headers["idempotency-key"] !== undefined).toBe(method !== "GET");
    expect(sent[0]?.headers["content-type"] !== undefined).toBe(body !== undefined);
  });

  it("validates billing and company options before any request", async () => {
    const { customer, mock } = setup(json({}));
    await expect(customer.billingPortal({ returnUrl: "" })).rejects.toThrow(TypeError);
    await expect(customer.setPlan({ sku: null } as never)).rejects.toThrow(TypeError);
    await expect(customer.setAddOn("seats", { quantity: 10_001 })).rejects.toThrow(RangeError);
    await expect(customer.grant("f", { value: -1 })).rejects.toThrow(RangeError);
    await expect(customer.setPlan("pro", { until: "soon" })).rejects.toThrow(
      new TypeError("Pass until as a valid date."),
    );
    await expect(customer.cancel({ addOn: "sso_addon", product: "core" })).rejects.toThrow(
      new TypeError("Pass either addOn or product, not both."),
    );
    await expect(customer.undoPendingChange({ addOn: " " })).rejects.toThrow(
      new TypeError("Name the plan by its id or its key."),
    );
    const adjustment = new TypeError(
      "Pass either by, a whole number other than 0, or to, a whole number of 0 or more.",
    );
    for (const options of [{ by: 0 }, { to: -1 }, { by: 1, to: 2 }, {}, { by: 1.5 }, { to: 2 ** 53 }]) {
      await expect(
        customer.adjustMeter(features.aiCredits, { ...options, idempotencyKey: "k" } as never),
      ).rejects.toThrow(adjustment);
    }
    await expect(customer.adjustMeter(features.aiCredits, { by: 1 } as never)).rejects.toThrow(
      new TypeError("Pass idempotencyKey: a key from your own unit of work, such as a message or job id."),
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("billing", () => {
  it.each([
    ["done", { next: "done", ...planChange }, { next: "done", changed: true, effective: "now", replayed: false }],
    [
      "pay",
      { next: "pay", url: "https://checkout.stripe.com/c/1" },
      { next: "pay", url: "https://checkout.stripe.com/c/1" },
    ],
    ["confirming", { next: "confirming" }, { next: "confirming" }],
    ["manage", { next: "manage", billedBy: "apple" }, { next: "manage", billedBy: "apple" }],
    ["a step this SDK does not know", { next: "wait_for_bank" }, { next: "unknown", raw: "wait_for_bank" }],
  ])("answers subscribe's %s step", async (_name, body, step) => {
    const { customer } = setup(json(body));
    expect(await customer.subscribe("pro", { returnUrl: "https://a.example/back" })).toMatchObject(step);
  });

  it("carries replayed on a done step and on a plan change", async () => {
    const { customer } = setup(
      json({ next: "done", ...planChange, changed: false }, 200, { "idempotent-replayed": "true" }),
    );
    expect(await customer.subscribe("pro", { idempotencyKey: "deal-1" })).toMatchObject({
      changed: false,
      replayed: true,
    });
    const change = await customer.setPlan("pro", { idempotencyKey: "deal-1" });
    expect(change).toMatchObject({ changed: false, replayed: true });
    expect(change.at).toBeInstanceOf(Date);
  });

  it("fails a step missing its fields as invalid_response", async () => {
    const { customer } = setup(json({ next: "pay" }));
    await expect(customer.subscribe("pro")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("raises a declined payment as an ApiError", async () => {
    const { customer } = setup(
      json(
        { error: { code: "payment_required", message: "Declined.", payment: { status: "declined", url: null } } },
        402,
      ),
    );
    await expect(customer.subscribe("pro")).rejects.toMatchObject({
      status: 402,
      code: "payment_required",
      payment: { status: "declined", url: null },
    });
  });

  it("answers the grant made and revoked", async () => {
    const grant = {
      id: "grt_1",
      feature: "sso",
      value: "true",
      from: "2026-10-01T00:00:00Z",
      until: null,
      revokedAt: null,
      reason: "",
      by: "key",
      actor: "agent_7",
    };
    const { customer } = setup(json({ grant }, 201));
    const made = await customer.grant("sso", { actor: "agent_7" });
    expect(made).toMatchObject({ grant: { id: "grt_1", actor: "agent_7" }, replayed: false });
    expect(made.grant.from).toBeInstanceOf(Date);
  });

  it("answers nothing for erase, and a sync's changed", async () => {
    const erased = setup(new Response(null, { status: 204 }));
    await expect(erased.customer.erase()).resolves.toBeUndefined();
    const synced = setup(json({ changed: false }));
    expect(await synced.customer.syncBilling()).toEqual({ changed: false });
  });
});

describe("details", () => {
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
  it("subscribes and syncs billing for me", async () => {
    const { fetch, sent } = fakeFetch((request) =>
      json(
        request.path.endsWith("/sync") ? { changed: true } : { next: "pay", url: "https://checkout.stripe.com/c/1" },
      ),
    );
    const client = new EntitlerClient({ token: "t", fetch });
    expect(await client.me.subscribe("pro", { period: "monthly", returnUrl: "app://back" })).toEqual({
      next: "pay",
      url: "https://checkout.stripe.com/c/1",
    });
    expect(await client.me.syncBilling()).toEqual({ changed: true });
    expect(sent.map((request) => request.path)).toEqual(["/customers/me/subscription", "/customers/me/billing/sync"]);
  });

  it("records usage for me", async () => {
    const { fetch, sent } = fakeFetch(json(usageAnswer()));
    const client = new EntitlerClient({ token: "t", fetch });
    await client.me.recordUsage(features.aiCredits, 2, { idempotencyKey: "msg-1" });
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
    expect("setPlan" in client.me).toBe(false);
    expect("erase" in client.me).toBe(false);
  });
});
