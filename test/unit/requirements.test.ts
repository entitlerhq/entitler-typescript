import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineFeature, EntitlerClient, EntitlerServer, TokenError } from "../../src/index.js";
import {
  decodeCheck,
  decodeCustomerSummary,
  decodeCustomerToken,
  decodeCustomerTrack,
  decodeDetails,
  decodeEntitlements,
  decodeFeatureList,
  decodeGrantChange,
  decodeIssuedSnapshot,
  decodePlanChange,
  decodePlans,
  decodePricing,
  decodeRegistered,
  decodeUsage,
  decodeUsageResult,
} from "../../src/shapes.js";
import { answers } from "../../src/testing.js";
import { apiError, checkAnswer, fakeFetch, json, jwt, usageAnswer } from "./fake.js";

const root = join(import.meta.dirname, "../..");
const credits = defineFeature("ai_credits", "metered");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function knownCodes(): Set<string> {
  const source = readFileSync(join(root, "src/errors.ts"), "utf8");
  const union = /export type ErrorCode =([\s\S]*?);/.exec(source)?.[1] ?? "";
  return new Set([...union.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] as string));
}

describe("error codes", () => {
  it("know every code in the frozen customers and keys documents", () => {
    const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/error-codes.json"), "utf8")) as {
      customers: string[];
      keys: string[];
    };
    const known = knownCodes();
    expect(fixture.customers.length).toBeGreaterThan(50);
    expect([...fixture.customers, ...fixture.keys].filter((code) => !known.has(code))).toEqual([]);
  });
});

describe("impossible instants", () => {
  const impossible = [
    "2026-02-31T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-03-01T24:00:00Z",
    "2026-03-01T00:00:00+25:00",
  ];

  it.each(impossible)("refuses %s in an answer", async (asOf) => {
    const { fetch } = fakeFetch(json(checkAnswer({ asOf })));
    const server = new EntitlerServer({ key: "k", fetch, cache: false });
    await expect(server.customer("u").check("f")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(impossible)("refuses %s as an argument, with no request", async (until) => {
    const { fetch, sent } = fakeFetch(json({}));
    const server = new EntitlerServer({ key: "k", fetch });
    await expect(server.customer("u").setPlan("pro", { until })).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
  });
});

describe("strict decoding", () => {
  const optional = new Set(["used", "held", "remaining", "resetsAt", "registration", "price"]);
  const cases: [string, unknown, (value: unknown) => unknown][] = [
    ["check", answers.check({ feature: "f" }), decodeCheck],
    ["entitlements", answers.entitlements({ entitlements: [answers.entitlement({ key: "f" })] }), decodeEntitlements],
    ["plans", answers.plans(), decodePlans],
    ["pricing", answers.pricing(), decodePricing],
    ["usage", answers.usage(), decodeUsage],
    ["usage result", answers.usageResult({ feature: "ai_credits" }), decodeUsageResult],
    ["plan change", answers.planChange(), decodePlanChange],
    ["grant change", answers.grantChange(), decodeGrantChange],
    ["registered", answers.registered(), decodeRegistered],
    ["customer token", answers.customerToken(), decodeCustomerToken],
    ["details", answers.details(), decodeDetails],
    ["customer summary", answers.customerSummary(), decodeCustomerSummary],
    ["features", answers.features(), decodeFeatureList],
    ["snapshot", answers.snapshot(), decodeIssuedSnapshot],
    ["track", answers.customerTrack(), decodeCustomerTrack],
  ];

  it.each(cases)("refuses a %s answer missing any required field, nullable ones included", (_name, body, decode) => {
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    expect(() => decode(wire)).not.toThrow();
    expect(() => decode({})).toThrow(TypeError);
    for (const field of Object.keys(wire).filter((name) => !optional.has(name))) {
      const { [field]: _, ...without } = wire;
      expect(() => decode(without), field).toThrow(TypeError);
    }
  });
});

describe("write tracking", () => {
  const fresh = { etag: '"v1"', "cache-control": "private, max-age=60" };

  it("never repeats a generation for a customer forgotten and written again during a read", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1000 });
    let release: (() => void) | undefined;
    const { fetch, sent } = fakeFetch(async (request) => {
      if (request.method === "POST") return json(usageAnswer());
      if (sent.filter((each) => each.method === "GET").length === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return json(checkAnswer(), 200, fresh);
    });
    const server = new EntitlerServer({ key: "k", fetch });
    const customer = server.customer("u");
    await customer.check("f");
    vi.setSystemTime(2000);
    await customer.recordUsage(credits, 1, { idempotencyKey: "w0" });
    vi.setSystemTime(3000);
    const reading = customer.check("f");
    await vi.waitFor(() => expect(release).toBeDefined());
    for (let index = 0; index < 1001; index += 1) {
      await server.customer(`other_${index}`).recordUsage(credits, 1, { idempotencyKey: `o${index}` });
    }
    vi.setSystemTime(3500);
    await customer.recordUsage(credits, 1, { idempotencyKey: "w1" });
    vi.setSystemTime(4000);
    release?.();
    await reading;
    vi.setSystemTime(4500);
    const before = sent.length;
    await customer.check("f");
    expect(sent.length).toBe(before + 1);
  });

  it("stays fast across many thousands of writes", async () => {
    const { fetch } = fakeFetch(json(usageAnswer()));
    const server = new EntitlerServer({ key: "k", fetch });
    const started = performance.now();
    for (let index = 0; index < 5000; index += 1) {
      await server.customer(`c${index}`).recordUsage(credits, 1, { idempotencyKey: `k${index}` });
    }
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});

describe("the outage window", () => {
  const kept = { etag: '"v1"', "cache-control": "private, max-age=0" };

  function outage(after: (sent: number, signal: AbortSignal | undefined) => Response | Promise<Response>) {
    let count = 0;
    const { fetch, sent } = fakeFetch((_request, init) => {
      count += 1;
      if (count === 1) return json(checkAnswer(), 200, kept);
      if (count === 2) return apiError(503, "unavailable");
      return after(count, init.signal ?? undefined);
    });
    const server = new EntitlerServer({ key: "k", fetch, maxRetries: 0, onError: () => {} });
    return { server, sent };
  }

  async function begin(server: EntitlerServer) {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    await server.customer("u").check("f");
    expect((await server.customer("u").check("f")).stale).toBe(true);
  }

  it("sends one test request for 20 concurrent reads after the window", async () => {
    let release: (() => void) | undefined;
    const { server, sent } = outage(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return json(checkAnswer(), 200, kept);
    });
    await begin(server);
    vi.setSystemTime(31_000);
    const reads = Array.from({ length: 20 }, () => server.customer("u").check("f"));
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    const answered = await Promise.all(reads);
    expect(sent).toHaveLength(3);
    expect(answered.filter((answer) => answer.stale)).toHaveLength(19);
  });

  it("ends the test on an error, so the next read asks again", async () => {
    const { server, sent } = outage((count) => (count === 3 ? apiError(404, "not_found") : json(checkAnswer())));
    await begin(server);
    vi.setSystemTime(31_000);
    await expect(server.customer("u").check("f")).rejects.toMatchObject({ status: 404 });
    expect((await server.customer("u").check("f")).stale).toBe(false);
    expect(sent).toHaveLength(4);
  });

  it("ends the test on cancellation, so the next read asks again", async () => {
    const { server, sent } = outage((count, signal) =>
      count === 3
        ? new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          })
        : json(checkAnswer()),
    );
    await begin(server);
    vi.setSystemTime(31_000);
    const controller = new AbortController();
    const probe = server.customer("u").check("f", { signal: controller.signal });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    controller.abort();
    await expect(probe).rejects.toBe(controller.signal.reason);
    expect((await server.customer("u").check("f")).stale).toBe(false);
    expect(sent).toHaveLength(4);
  });

  it("closes the window on any successful answer, a write included", async () => {
    const { server, sent } = outage(() => json(usageAnswer()));
    await begin(server);
    vi.setSystemTime(5000);
    await server.customer("other").recordUsage(credits, 1, { idempotencyKey: "k" });
    await server
      .customer("u")
      .check("f")
      .catch(() => undefined);
    expect(sent).toHaveLength(4);
  });
});

describe("token refresh", () => {
  function token(n: number): string {
    return jwt({ sub: "user_1", n, exp: Math.floor(Date.now() / 1000) + 3600 });
  }

  it("settles a shared refresh from its own outcome when one waiter cancels", async () => {
    let resolve: ((value: string) => void) | undefined;
    const provider = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const { fetch } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    const controller = new AbortController();
    const cancelled = client.me.check("f", { signal: controller.signal });
    const waiting = client.me.check("f");
    controller.abort();
    await expect(cancelled).rejects.toBe(controller.signal.reason);
    resolve?.(token(1));
    expect((await waiting).entitled).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("answers a hanging provider with a TokenError, then asks it again", async () => {
    const provider = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>(() => {}))
      .mockImplementation(async () => token(2));
    const { fetch } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false, timeout: 20 });
    await expect(client.me.check("f")).rejects.toBeInstanceOf(TokenError);
    expect((await client.me.check("f")).entitled).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("recovers from 503, then 401, then 200", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let issued = 0;
    const provider = vi.fn(async () => token(++issued));
    const { fetch, sent } = fakeFetch(apiError(503, "unavailable"), apiError(401, "unauthorised"), json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false, maxRetries: 2 });
    expect((await client.me.check("f")).entitled).toBe(true);
    expect(sent).toHaveLength(3);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sent[2]?.headers.authorization).toBe(`Bearer ${token(2)}`);
  });
});

describe("durations", () => {
  it("clamps a long timeout to what timers hold, rather than overflowing into an immediate timeout", async () => {
    const { fetch } = fakeFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(checkAnswer())), 5)),
    );
    const server = new EntitlerServer({ key: "k", fetch, cache: false, timeout: 1e12 });
    expect((await server.customer("u").check("f", { timeout: 3e10 })).entitled).toBe(true);
  });
});

describe("backoff", () => {
  it("never overflows its bound, however many retries are allowed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 0 });
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const { fetch, sent } = fakeFetch(apiError(503, "unavailable"));
    const server = new EntitlerServer({ key: "k", fetch, cache: false, maxRetries: 64 });
    const call = server
      .customer("u")
      .check("f")
      .catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    expect(await call).toMatchObject({ status: 503 });
    expect(sent).toHaveLength(65);
    const waited = Date.now();
    expect(Number.isFinite(waited)).toBe(true);
    expect(waited).toBeGreaterThan(500 * 0.99 + 1000 * 0.99 + 2000 * 0.99 + 4000 * 0.99 + 60 * 8000 * 0.99);
    expect(waited).toBeLessThanOrEqual(500 + 1000 + 2000 + 4000 + 60 * 8000);
  });
});

describe("stamps on a clock that never moves", () => {
  const fresh = { etag: '"v1"', "cache-control": "private, max-age=60" };

  it("keeps a read answered after a write fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
    const { fetch, sent } = fakeFetch((request) =>
      request.method === "POST" ? json(usageAnswer()) : json(checkAnswer(), 200, fresh),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await customer.recordUsage(credits, 1, { idempotencyKey: "w" });
    await customer.check("f");
    await customer.check("f");
    expect(sent.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("never counts an answer exactly max-age old as fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
    const { fetch, sent } = fakeFetch(json(checkAnswer(), 200, fresh));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await customer.check("f");
    expect(sent).toHaveLength(1);
    vi.setSystemTime(61_000);
    await customer.check("f");
    expect(sent).toHaveLength(2);
  });
});
