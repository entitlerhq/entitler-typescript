import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type CacheEntry,
  type CacheStore,
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  MemoryCache,
} from "../../src/index.js";
import { apiError, checkAnswer, context, fakeFetch, json, jwt, usageAnswer } from "./fake.js";

const aiCredits = defineFeature("ai_credits", "metered");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const fresh = { etag: '"v1"', "cache-control": "private, max-age=60" };

function spyStore(): CacheStore & { entries: Map<string, CacheEntry> } {
  const entries = new Map<string, CacheEntry>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, entry) => {
      entries.set(key, entry);
    },
  };
}

describe("the answer cache", () => {
  it("answers a fresh entry without a request", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    const second = await customer.check("f");
    expect(sent).toHaveLength(1);
    expect(second.stale).toBe(false);
    expect(second.asOf).toBeInstanceOf(Date);
  });

  it("revalidates with If-None-Match once max-age passes, and renews from the 304", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, fresh),
      new Response(null, { status: 304, headers: { etag: '"v2"', "cache-control": "max-age=60" } }),
    );
    const store = spyStore();
    const customer = new EntitlerServer({ key: "k", fetch, cache: store }).customer("u");
    await customer.check("f");
    vi.setSystemTime(61_000);
    const check = await customer.check("f");
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(check.entitled).toBe(true);
    const [entry] = store.entries.values();
    expect(entry).toMatchObject({ v: 1, etag: '"v2"', cacheControl: "max-age=60", receivedAt: 61_000 });
    await customer.check("f");
    expect(sent).toHaveLength(2);
  });

  it("revalidates an entry with no-cache on every read", async () => {
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "private, no-cache" }),
      new Response(null, { status: 304 }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await customer.check("f");
    await customer.check("f");
    expect(sent).toHaveLength(3);
    expect(sent[2]?.headers["if-none-match"]).toBe('"v1"');
  });

  it("revalidates a fresh entry after this client writes to that customer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1000 });
    const { fetch, sent } = fakeFetch((request) => {
      if (request.method === "POST") return json(usageAnswer());
      return request.headers["if-none-match"]
        ? new Response(null, { status: 304, headers: fresh })
        : json(checkAnswer(), 200, fresh);
    });
    const server = new EntitlerServer({ key: "k", fetch });
    await server.customer("u").check("f");
    await server.customer("other").check("f");
    vi.setSystemTime(2000);
    await server.customer("u").recordUsage(aiCredits, 1);
    vi.setSystemTime(3000);
    await server.customer("u").check("f");
    await server.customer("other").check("f");
    expect(sent.map((request) => [request.method, request.path, request.headers["if-none-match"]])).toEqual([
      ["GET", "/customers/u/entitlements/f", undefined],
      ["GET", "/customers/other/entitlements/f", undefined],
      ["POST", "/customers/u/usage", undefined],
      ["GET", "/customers/u/entitlements/f", '"v1"'],
    ]);
  });

  it("fails a 304 with nothing kept", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 304 }));
    const error = await new EntitlerServer({ key: "k", fetch })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 304, code: "http_error" });
  });

  it("never keeps a no-store answer", async () => {
    const store = spyStore();
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-store, max-age=60" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch, cache: store }).customer("u");
    await customer.check("f");
    await customer.check("f");
    expect(store.entries.size).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("keeps nothing without an ETag or max-age", async () => {
    const store = spyStore();
    const { fetch } = fakeFetch(json(checkAnswer()));
    await new EntitlerServer({ key: "k", fetch, cache: store }).customer("u").check("f");
    expect(store.entries.size).toBe(0);
  });

  it("is off with cache: false", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch, cache: false }).customer("u");
    await customer.check("f");
    await customer.check("f");
    expect(sent).toHaveLength(2);
  });

  it("answers copies, so changing one never changes another", async () => {
    const { fetch } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    const first = (await customer.check("f")) as unknown as { sources: unknown[] };
    first.sources.length = 0;
    const second = await customer.check("f");
    expect(second.sources).toHaveLength(1);
  });

  it("keys entries by lowercase SHA-256 hex holding no credential", async () => {
    const store = spyStore();
    const { fetch } = fakeFetch(json(checkAnswer(), 200, fresh));
    await new EntitlerServer({ key: "ent_test_secret", fetch, cache: store }).customer("u").check("f");
    const [key] = store.entries.keys();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...store.entries])).not.toContain("ent_test_secret");
  });

  it("keys entries by principal, as-of and visitor", async () => {
    const store = spyStore();
    const { fetch, sent } = fakeFetch(
      json({ ...context, customer: null, defaultPlan: null, products: [], plans: [] }, 200, fresh),
    );
    const a = new EntitlerServer({ key: "key_a", fetch, cache: store });
    const b = new EntitlerServer({ key: "key_b", fetch, cache: store });
    const past = new EntitlerServer({ key: "key_a", fetch, cache: store, asOf: "2026-01-01T00:00:00Z" });
    await a.pricing();
    await a.pricing();
    await b.pricing();
    await past.pricing();
    await a.pricing({ visitor: "visitor_aaaaaaaaaaaa" });
    await a.pricing({ visitor: "visitor_aaaaaaaaaaaa" });
    expect(sent).toHaveLength(4);
    expect(store.entries.size).toBe(4);
  });

  it("keys entries by the credential itself, never by claims", async () => {
    const store = spyStore();
    const visitor = "visitor_aaaaaaaaaaaa";
    const claims = { iss: "https://api.entitler.dev/customers", eid: "env_1", sub: "u" };
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, fresh));
    await new EntitlerClient({ token: jwt(claims), fetch, cache: store, visitor }).me.check("f");
    await new EntitlerClient({ token: jwt(claims), fetch, cache: store, visitor }).me.check("f");
    expect(sent).toHaveLength(1);
    await new EntitlerClient({ token: jwt({ ...claims, n: 2 }), fetch, cache: store, visitor }).me.check("f");
    expect(sent).toHaveLength(2);
  });

  it("keys identity clients by the key and the identity token together", async () => {
    const store = spyStore();
    const visitor = "visitor_aaaaaaaaaaaa";
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, fresh));
    await new EntitlerClient({ key: "pk", identityToken: "idt_a", fetch, cache: store, visitor }).me.check("f");
    await new EntitlerClient({ key: "pk", identityToken: "idt_a", fetch, cache: store, visitor }).me.check("f");
    await new EntitlerClient({ key: "pk", identityToken: "idt_b", fetch, cache: store, visitor }).me.check("f");
    await new EntitlerClient({ key: "pk2", identityToken: "idt_a", fetch, cache: store, visitor }).me.check("f");
    expect(sent).toHaveLength(3);
  });

  it("serves concurrent reads safely", async () => {
    const { fetch } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    const checks = await Promise.all(Array.from({ length: 20 }, () => customer.check("f")));
    expect(checks.every((check) => check.entitled)).toBe(true);
  });

  it("caches entitlement lists, the customer's plans, customer pricing, pricing and features", async () => {
    const { fetch, sent } = fakeFetch((request) =>
      json(
        request.path.endsWith("/entitlements")
          ? { customer: "u", ...context, asOf: "2026-10-09T00:00:00Z", entitlements: [] }
          : request.path.endsWith("/plans")
            ? { customer: "u", ...context, asOf: "2026-10-09T00:00:00Z", held: [], options: [] }
            : request.path === "/pricing/features"
              ? { ...context, features: [] }
              : { ...context, customer: null, defaultPlan: null, products: [], plans: [] },
        200,
        fresh,
      ),
    );
    const server = new EntitlerServer({ key: "k", fetch });
    const customer = server.customer("u");
    for (let i = 0; i < 2; i += 1) {
      await customer.entitlements();
      await customer.plans();
      await customer.pricing();
      await server.pricing();
      await server.features();
    }
    expect(sent).toHaveLength(5);
  });
});

describe("stale answers", () => {
  it("answers a kept entry with stale true when Entitler is unreachable, and calls onError", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onError = vi.fn();
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      apiError(503, "unavailable"),
    );
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    await customer.check("f");
    const check = await customer.check("f");
    expect(check.stale).toBe(true);
    expect(check.entitled).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ status: 503 });
  });

  it.each([
    ["a connection failure", new TypeError("offline")],
    ["a 429", apiError(429, "rate_limited")],
    ["a 500", apiError(500, "internal")],
  ])("stands in after %s", async (_name, failure) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }), failure);
    const customer = new EntitlerServer({ key: "k", fetch, maxRetries: 0 }).customer("u");
    await customer.check("f");
    expect((await customer.check("f")).stale).toBe(true);
  });

  it("throws other failures", async () => {
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      apiError(404, "feature_not_found"),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await expect(customer.check("f")).rejects.toMatchObject({ code: "feature_not_found" });
  });

  it("does not stand in once staleFor has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      apiError(503, "unavailable"),
    );
    const customer = new EntitlerServer({ key: "k", fetch, staleFor: 1000, maxRetries: 0 }).customer("u");
    await customer.check("f");
    vi.setSystemTime(1000);
    await expect(customer.check("f")).rejects.toMatchObject({ status: 503 });
  });
});

describe("MemoryCache", () => {
  it("drops the least recently used entry when full", () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    const entry = { v: 1 as const, body: "{}", receivedAt: 0 };
    cache.set("a", entry);
    cache.set("b", entry);
    cache.get("a");
    cache.set("c", entry);
    expect(cache.get("a")).toBe(entry);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(entry);
    cache.set("c", { v: 1, body: "[]", receivedAt: 1 });
    expect(cache.get("c")?.body).toBe("[]");
  });

  it("holds 1,000 answers by default", () => {
    const cache = new MemoryCache();
    for (let i = 0; i <= 1000; i += 1) cache.set(String(i), { v: 1, body: "{}", receivedAt: i });
    expect(cache.get("0")).toBeUndefined();
    expect(cache.get("1")).toBeDefined();
  });

  it("refuses a size below 1", () => {
    expect(() => new MemoryCache({ maxEntries: 0 })).toThrow(RangeError);
  });
});

describe("writes that touch many customers", () => {
  it("revalidates each batch customer's answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1000 });
    const { fetch, sent } = fakeFetch((request) => {
      if (request.method === "POST") return json({ results: [], recorded: 0, duplicates: 0, errors: 0 });
      return request.headers["if-none-match"]
        ? new Response(null, { status: 304, headers: fresh })
        : json(checkAnswer(), 200, fresh);
    });
    const server = new EntitlerServer({ key: "k", fetch });
    await server.customer("a").check("f");
    vi.setSystemTime(2000);
    await server.recordUsageBatch([{ customer: "a", feature: aiCredits }]);
    vi.setSystemTime(3000);
    await server.customer("a").check("f");
    expect(sent.at(-1)?.headers["if-none-match"]).toBe('"v1"');
  });

  it("never refreshes a token for a call that sends no credential", async () => {
    const provider = vi.fn(() => jwt({ sub: "u" }));
    const { fetch, sent } = fakeFetch(apiError(401, "unauthorised"));
    await expect(new EntitlerClient({ token: provider, fetch }).snapshotKeys()).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
  });
});
