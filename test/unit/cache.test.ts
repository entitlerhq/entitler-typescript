import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type CacheEntry, type CacheStore, EntitlerServer, MemoryCache } from "../../src/index.js";
import { apiError, checkAnswer, fakeFetch, json } from "./fake.js";

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
    expect(entry).toMatchObject({ v: 1, etag: '"v2"', cacheControl: "max-age=60" });
    expect(Math.floor(entry?.receivedAt ?? 0)).toBe(61_000);
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

  it("fails a 304 with nothing kept", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 304 }));
    const error = await new EntitlerServer({ key: "k", fetch })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 304, code: "Unknown", reason: null });
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

  it("serves concurrent reads safely", async () => {
    const { fetch } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    const checks = await Promise.all(Array.from({ length: 20 }, () => customer.check("f")));
    expect(checks.every((check) => check.entitled)).toBe(true);
  });
});

describe("stale answers", () => {
  it("answers a kept entry with stale true when Entitler is unreachable, and calls onError", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onError = vi.fn();
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      apiError(503, "Unavailable", "UNAVAILABLE"),
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
    ["a 429", apiError(429, "ResourceExhausted", "API_RATE_LIMITED")],
    ["a 500", apiError(500, "Internal", "FAILED")],
  ])("stands in after %s", async (_name, failure) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }), failure);
    const customer = new EntitlerServer({ key: "k", fetch, maxRetries: 0 }).customer("u");
    await customer.check("f");
    expect((await customer.check("f")).stale).toBe(true);
  });

  it("keeps asking Entitler after an answer it cannot read", async () => {
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      json({ entitlement: {} }),
      json(checkAnswer(), 200, { etag: '"v2"', "cache-control": "no-cache" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    expect((await customer.check("f")).stale).toBe(true);
    expect((await customer.check("f")).stale).toBe(false);
    expect(sent).toHaveLength(3);
  });

  it("asks Entitler, without If-None-Match, when a kept entry can't be read", async () => {
    const onError = vi.fn();
    const store = spyStore();
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch, cache: store, onError }).customer("u");
    await customer.check("f");
    for (const [key, entry] of store.entries) store.entries.set(key, { ...entry, body: "{" });
    expect((await customer.check("f")).entitled).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers["if-none-match"]).toBeUndefined();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ reason: "RESPONSE_INVALID" });
  });

  it("lets a caller's abort and close end a cache store that never answers", async () => {
    const onError = vi.fn();
    const stuck: CacheStore = { get: () => new Promise(() => {}), set: () => new Promise(() => {}) };
    const { fetch } = fakeFetch(json(checkAnswer(), 200, fresh));
    const server = new EntitlerServer({ key: "k", fetch, cache: stuck, onError });
    const controller = new AbortController();
    const aborted = server.customer("u").check("f", { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toBe(controller.signal.reason);
    const closed = server.customer("u").check("f");
    server.close();
    await expect(closed).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves no unhandled rejection from a store that fails after an abort", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const controller = new AbortController();
    const failing: CacheStore = {
      get: () => {
        controller.abort();
        return Promise.reject(new Error("store down"));
      },
      set: () => undefined,
    };
    const { fetch } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch, cache: failing }).customer("u");
    await expect(customer.check("f", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("passes an abort on even when the store then fails at once", async () => {
    const onError = vi.fn();
    const controller = new AbortController();
    const store: CacheStore = {
      get: () => undefined,
      set: () => {
        throw new Error("store down");
      },
    };
    const { fetch } = fakeFetch(() => {
      controller.abort();
      return json(checkAnswer(), 200, fresh);
    });
    const customer = new EntitlerServer({ key: "k", fetch, cache: store, onError }).customer("u");
    await expect(customer.check("f", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("throws other failures", async () => {
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      apiError(404, "NotFound", "FEATURE_NOT_FOUND"),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await expect(customer.check("f")).rejects.toMatchObject({ reason: "FEATURE_NOT_FOUND" });
  });

  it("does not stand in once staleFor has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache" }),
      apiError(503, "Unavailable", "UNAVAILABLE"),
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
