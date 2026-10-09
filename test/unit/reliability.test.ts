import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, defineFeature, EntitlerClient, EntitlerServer, TokenError } from "../../src/index.js";
import { apiError, checkAnswer, context, fakeFetch, json, jwt, usageAnswer } from "./fake.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const aiCredits = defineFeature("ai_credits", "metered");
const kept = { etag: '"v1"', "cache-control": "private, no-cache" };

describe("answers the SDK cannot read", () => {
  it.each([
    ["not JSON", new Response("<html>captive portal</html>", { status: 200, headers: { "x-request-id": "r1" } })],
    ["not an object", json("text")],
    ["empty", new Response(null, { status: 200 })],
  ])("raises invalid_response for a 2xx that is %s, without retrying", async (_name, reply) => {
    const { fetch, sent } = fakeFetch(reply);
    const error = (await new EntitlerServer({ key: "k", fetch, cache: false })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 200,
      code: "invalid_response",
      message: "Entitler sent an answer this SDK cannot read.",
    });
    expect(error.cause).toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it("stands in with a kept answer after an invalid_response", async () => {
    const onError = vi.fn();
    const { fetch } = fakeFetch(json(checkAnswer(), 200, kept), new Response("<html>", { status: 200 }));
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    await customer.check("f");
    expect((await customer.check("f")).stale).toBe(true);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "invalid_response" });
  });
});

describe("after Entitler is unreachable", () => {
  it("answers kept entries without a request for 30 seconds, then lets one request test the API", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    vi.spyOn(Math, "random").mockReturnValue(0);
    let down = false;
    const { fetch, sent } = fakeFetch((request) =>
      down
        ? apiError(503, "unavailable")
        : request.headers["if-none-match"]
          ? new Response(null, { status: 304, headers: kept })
          : json(checkAnswer(), 200, kept),
    );
    const customer = new EntitlerServer({ key: "k", fetch, maxRetries: 0 }).customer("u");
    await customer.check("f");
    down = true;
    expect((await customer.check("f")).stale).toBe(true);
    expect(sent).toHaveLength(2);
    vi.setSystemTime(29_000);
    expect((await customer.check("f")).stale).toBe(true);
    expect(sent).toHaveLength(2);
    vi.setSystemTime(31_000);
    down = false;
    expect((await customer.check("f")).stale).toBe(false);
    expect(sent).toHaveLength(3);
    expect((await customer.check("f")).stale).toBe(false);
    expect(sent).toHaveLength(4);
  });

  it("waits out a longer Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, kept),
      apiError(503, "unavailable", "Later.", { "retry-after": "60" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await customer.check("f");
    vi.setSystemTime(45_000);
    expect((await customer.check("f")).stale).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("answers other reads stale while one request tests the API", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    vi.spyOn(Math, "random").mockReturnValue(0);
    let release: (response: Response) => void = () => {};
    let phase = "up";
    const { fetch, sent } = fakeFetch(() => {
      if (phase === "up") return json(checkAnswer(), 200, kept);
      if (phase === "down") return apiError(503, "unavailable");
      return new Promise<Response>((resolve) => (release = resolve));
    });
    const customer = new EntitlerServer({ key: "k", fetch, maxRetries: 0 }).customer("u");
    await customer.check("f");
    phase = "down";
    await customer.check("f");
    vi.setSystemTime(31_000);
    phase = "slow";
    const probe = customer.check("f");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect((await customer.check("f")).stale).toBe(true);
    expect(sent).toHaveLength(3);
    release(json(checkAnswer(), 200, kept));
    expect((await probe).stale).toBe(false);
  });
});

describe("the platform's HTTP cache", () => {
  it("is bypassed with cache: no-store", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    await new EntitlerServer({ key: "k", fetch }).customer("u").check("f");
    expect((mock.mock.calls[0]?.[1] as RequestInit | undefined)?.cache).toBe("no-store");
  });
});

describe("custom stores", () => {
  it("count a failing get as a miss and skip a failing set, passing both to onError", async () => {
    const onError = vi.fn();
    const failure = new Error("redis down");
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, kept));
    const cache = {
      get: () => Promise.reject(failure),
      set: () => {
        throw failure;
      },
    };
    const customer = new EntitlerServer({ key: "k", fetch, cache, onError }).customer("u");
    expect((await customer.check("f")).entitled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.every(([error]) => error === failure)).toBe(true);
  });

  it("ignore an entry that is not a cache entry", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, kept));
    const cache = { get: () => ({ body: 3 }) as never, set: () => {} };
    await new EntitlerServer({ key: "k", fetch, cache }).customer("u").check("f");
    expect(sent[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("receive the entry's lifetime: staleFor plus its max-age", async () => {
    const set = vi.fn();
    const { fetch } = fakeFetch(json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=60" }));
    await new EntitlerServer({ key: "k", fetch, cache: { get: () => undefined, set }, staleFor: 1000 })
      .customer("u")
      .check("f");
    expect(set.mock.calls[0]?.[2]).toBe(61_000);
  });

  it("round-trip entries through JSON", async () => {
    const entries = new Map<string, string>();
    const cache = {
      get: (key: string) => {
        const text = entries.get(key);
        return text === undefined ? undefined : JSON.parse(text);
      },
      set: (key: string, entry: unknown) => void entries.set(key, JSON.stringify(entry)),
    };
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=60" }));
    const customer = new EntitlerServer({ key: "k", fetch, cache }).customer("u");
    await customer.check("f");
    const second = await customer.check("f");
    expect(sent).toHaveLength(1);
    expect(second.asOf).toBeInstanceOf(Date);
  });
});

describe("token lifetimes", () => {
  it("asks for a 60-second token at most once per request", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000_000 });
    const provider = vi.fn(() => {
      const now = Math.floor(Date.now() / 1000);
      return jwt({ sub: "u", iat: now, exp: now + 60 });
    });
    const { fetch } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await client.me.check("f");
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000_000 + 31_000);
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("uses a token that is already expiring for the request it was asked for", async () => {
    const provider = vi.fn(() => jwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 1 }));
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("measures half the lifetime from receipt without an iat", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000_000 });
    const provider = vi.fn(() => jwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 40 }));
    const { fetch } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await client.me.check("f");
    vi.setSystemTime(1_000_000_000 + 19_000);
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000_000 + 21_000);
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("refuses a provider's token without exp as unreadable", async () => {
    const provider = vi.fn(() => jwt({ sub: "u" }));
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    await expect(new EntitlerClient({ token: provider, fetch, cache: false }).me.check("f")).rejects.toBeInstanceOf(
      TokenError,
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("idempotency keys", () => {
  it.each([" leading", "trailing ", " "])("refuses %j", async (key) => {
    const { fetch, mock } = fakeFetch(json(usageAnswer()));
    await expect(
      new EntitlerServer({ key: "k", fetch }).customer("u").recordUsage(aiCredits, 1, { idempotencyKey: key }),
    ).rejects.toThrow(new TypeError("Pass idempotencyKey as 1 to 200 printable ASCII characters."));
    expect(mock).not.toHaveBeenCalled();
  });

  it("allows inner spaces", async () => {
    const { fetch, sent } = fakeFetch(json(usageAnswer()));
    await new EntitlerServer({ key: "k", fetch }).customer("u").recordUsage(aiCredits, 1, { idempotencyKey: "job 42" });
    expect(sent[0]?.headers["idempotency-key"]).toBe("job 42");
  });

  it("answers the spec's message for an amount", async () => {
    const customer = new EntitlerServer({ key: "k" }).customer("u");
    await expect(customer.recordUsage(aiCredits, 0, { idempotencyKey: "k" })).rejects.toThrow(
      new RangeError("Pass amount as a whole number from 1 to 9007199254740991."),
    );
    await expect(customer.settleUsage("h", -1)).rejects.toThrow(
      new RangeError("Pass amount as a whole number from 0 to the held amount."),
    );
  });
});

describe("batches that fail", () => {
  it("answer a failed request's events error and carry on, one key per request", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let request = 0;
    const { fetch, sent } = fakeFetch((sentRequest) => {
      request += 1;
      if (request <= 3) throw new TypeError("offline");
      const events = (sentRequest.body as { events: unknown[] }).events;
      return json({
        results: events.map((_, index) => ({ index, outcome: "recorded", id: `u${index}`, late: false, error: null })),
        recorded: events.length,
        duplicates: 0,
        errors: 0,
      });
    });
    const server = new EntitlerServer({ key: "k", fetch });
    const events = Array.from({ length: 501 }, (_, i) => ({
      customer: `c${i}`,
      feature: aiCredits,
      amount: 1,
      idempotencyKey: `e${i}`,
    }));
    const batch = await server.recordUsageBatch(events);
    expect(batch.results).toHaveLength(501);
    expect(batch.results[0]).toMatchObject({
      index: 0,
      outcome: "error",
      idempotencyKey: "e0",
      error: { code: "connection_failed", message: "Entitler could not be reached." },
    });
    expect(batch.results[500]).toMatchObject({ index: 500, outcome: "recorded", idempotencyKey: "e500" });
    expect(batch).toMatchObject({ recorded: 1, duplicates: 0, errors: 500 });
    const keys = sent.map((each) => each.headers["idempotency-key"]);
    expect(keys[0]).toMatch(/^batch:[0-9a-f]{64}$/);
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(keys[3]).toMatch(/^batch:[0-9a-f]{64}$/);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("answer an API error with its code, and a timeout with timed_out", async () => {
    const { fetch } = fakeFetch(apiError(403, "scope_required", "This key lacks usage:write."));
    const batch = await new EntitlerServer({ key: "k", fetch }).recordUsageBatch([
      { customer: "a", feature: aiCredits, amount: 1, idempotencyKey: "e" },
    ]);
    expect(batch.results[0]?.error).toEqual({ code: "scope_required", message: "This key lacks usage:write." });
    const slow = fakeFetch(
      (_sent, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const timed = await new EntitlerServer({
      key: "k",
      fetch: slow.fetch,
      timeout: 10,
      maxRetries: 0,
    }).recordUsageBatch([{ customer: "a", feature: aiCredits, amount: 1, idempotencyKey: "e" }]);
    expect(timed.results[0]?.error?.code).toBe("timed_out");
  });

  it("propagate cancellation", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(() => {
      controller.abort();
      throw new Error("aborted");
    });
    const error = await new EntitlerServer({ key: "k", fetch })
      .recordUsageBatch([{ customer: "a", feature: aiCredits, amount: 1, idempotencyKey: "e" }], {
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
  });
});

describe("visitors per call", () => {
  it("replace the in-app client's visitor for that request only", async () => {
    const { fetch, sent } = fakeFetch(json({ ...context, customer: "u", defaultPlan: null, products: [], plans: [] }));
    const client = new EntitlerClient({ token: "t", fetch, cache: false });
    await client.me.pricing({ visitor: "campaign_visitor_01" });
    await client.me.pricing();
    expect(sent.map((request) => request.headers["entitler-visitor"])).toEqual(["campaign_visitor_01", client.visitor]);
  });
});

describe("the usage log", () => {
  it("answers its first page and starts from a cursor", async () => {
    const event = {
      id: "e1",
      feature: "ai_credits",
      amount: 1,
      kind: "use",
      setTo: null,
      source: "api",
      actor: null,
      at: "2026-10-09T00:00:00Z",
      cancelledAt: null,
    };
    const { fetch, sent } = fakeFetch(
      json({
        customer: "u",
        ...context,
        asOf: "2026-10-09T00:00:00Z",
        metersStartAgainAt: null,
        features: [],
        log: { items: [event], next: null },
      }),
    );
    const usage = await new EntitlerServer({ key: "k", fetch }).customer("u").usage({ cursor: "c5" });
    expect(sent[0]?.query.cursor).toBe("c5");
    expect(usage.log.items).toHaveLength(1);
    expect(usage.log.next).toBeNull();
  });
});
