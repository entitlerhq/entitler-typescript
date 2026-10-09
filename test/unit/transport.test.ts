import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConnectionError,
  defineFeature,
  EntitlerError,
  EntitlerServer,
  TimeoutError,
  VERSION,
} from "../../src/index.js";
import { apiError, checkAnswer, fakeFetch, json, usageAnswer } from "./fake.js";

const aiCredits = defineFeature("ai_credits", "metered");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const g = globalThis as { Deno?: { version: { deno: string } } };
const runtime = g.Deno
  ? `deno/${g.Deno.version.deno}`
  : process.versions.bun
    ? `bun/${process.versions.bun}`
    : `node/${process.versions.node}`;

function server(fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}) {
  return new EntitlerServer({ key: "ent_test_secret", fetch, cache: false, ...options });
}

describe("requests", () => {
  it("sends the standard headers and no body on a read", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await server(fetch).customer("user_1").check("export_pdf");
    const [request] = sent;
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://api.entitler.dev/customers/user_1/entitlements/export_pdf");
    expect(request?.headers.authorization).toBe("Bearer ent_test_secret");
    expect(request?.headers.accept).toBe("application/json");
    expect(request?.headers["content-type"]).toBeUndefined();
    expect(request?.headers["idempotency-key"]).toBeUndefined();
    expect(request?.headers["entitler-visitor"]).toBeUndefined();
    expect(request?.headers["user-agent"]).toBe(`entitler-typescript/${VERSION} ${runtime}`);
    expect(request?.body).toBeUndefined();
  });

  it("encodes path segments like encodeURIComponent", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await server(fetch).customer("google:a/b c?é").check("export pdf");
    expect(sent[0]?.url).toBe(
      "https://api.entitler.dev/customers/google%3Aa%2Fb%20c%3F%C3%A9/entitlements/export%20pdf",
    );
  });

  it("removes trailing slashes from the base URL", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await server(fetch, { baseUrl: "http://localhost:8787//" }).customer("u").check("f");
    expect(sent[0]?.url).toBe("http://localhost:8787/customers/u/entitlements/f");
  });

  it("calls the injected fetch unbound", async () => {
    let self: unknown = "unset";
    const fetch = function (this: unknown) {
      self = this;
      return Promise.resolve(json(checkAnswer()));
    } as unknown as typeof globalThis.fetch;
    await server(fetch).customer("u").check("f");
    expect(self).toBeUndefined();
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(checkAnswer()));
    await new EntitlerServer({ key: "k", cache: false }).customer("u").check("f");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("sends a generated UUID v4 idempotency key and a JSON body on a write", async () => {
    const { fetch, sent } = fakeFetch(json(usageAnswer()));
    await server(fetch).customer("u").settleUsage("hold_1", 3);
    expect(sent[0]?.headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sent[0]?.headers["content-type"]).toBe("application/json");
  });

  it("refuses a usage report without an idempotency key before any request", async () => {
    const { fetch, mock } = fakeFetch(json(usageAnswer()));
    const customer = server(fetch).customer("u") as unknown as {
      recordUsage(feature: unknown, amount: number, options?: object): Promise<unknown>;
    };
    await expect(customer.recordUsage(aiCredits, 3, {})).rejects.toThrow(
      new TypeError("Pass idempotencyKey: a key from your own unit of work, such as a message or job id."),
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("sends the caller's idempotency key", async () => {
    const { fetch, sent } = fakeFetch(json(usageAnswer()));
    await server(fetch).customer("u").recordUsage(aiCredits, 3, { idempotencyKey: "job-1" });
    expect(sent[0]?.headers["idempotency-key"]).toBe("job-1");
  });

  it.each(["", "x".repeat(201), "tab\there", "é"])("refuses the idempotency key %j before any request", async (key) => {
    const { fetch, mock } = fakeFetch(json(usageAnswer()));
    await expect(server(fetch).customer("u").recordUsage(aiCredits, 3, { idempotencyKey: key })).rejects.toThrow(
      new TypeError("Pass idempotencyKey as 1 to 200 printable ASCII characters."),
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("decodes timestamps as dates and keeps unknown fields and enum values", async () => {
    const { fetch } = fakeFetch(
      json(checkAnswer({ type: "brand_new", surprise: { nested: true }, resetsAt: "2026-11-01T10:00:00+10:00" })),
    );
    const check = await server(fetch).customer("u").check("f");
    expect(check.asOf).toEqual(new Date("2026-10-09T01:00:00.000Z"));
    expect(check.resetsAt).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(check.type).toBe("brand_new");
    expect((check as unknown as { surprise: unknown }).surprise).toEqual({ nested: true });
  });
});

describe("errors", () => {
  it("decodes an API error with every field", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          error: {
            code: "payment_required",
            message: "The customer must confirm the payment.",
            payment: { status: "requires_action", url: "https://pay.example/1" },
            listingGaps: [{ kind: "unlisted", plan: "pro", key: "k", period: "monthly", channel: null }],
          },
        },
        402,
        { "x-request-id": "req_1" },
      ),
    );
    const error = await server(fetch)
      .customer("u")
      .subscribe("pro", { idempotencyKey: "change-1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(EntitlerError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 402,
      code: "payment_required",
      message: "The customer must confirm the payment.",
      requestId: "req_1",
      retryAfter: undefined,
      idempotencyKey: "change-1",
      payment: { status: "requires_action", url: "https://pay.example/1" },
      listingProblems: [],
    });
    expect((error as ApiError).listingGaps).toHaveLength(1);
  });

  it("drops a payment with an unknown status", async () => {
    const { fetch } = fakeFetch(
      json({ error: { code: "payment_required", message: "m", payment: { status: "odd", url: null } } }, 402),
    );
    const error = (await server(fetch)
      .customer("u")
      .subscribe("pro")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.payment).toBeUndefined();
  });

  it("answers http_error for an answer without an error body", async () => {
    const { fetch } = fakeFetch(new Response("<html>bad gateway</html>", { status: 418 }));
    const error = (await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 418, code: "http_error", message: "Entitler answered with HTTP 418." });
    expect(error.requestId).toBeUndefined();
    expect(error.idempotencyKey).toBeUndefined();
  });

  it("raises a connection error carrying the cause and the idempotency key", async () => {
    const cause = new TypeError("fetch failed");
    const { fetch } = fakeFetch(cause);
    const error = (await server(fetch, { maxRetries: 0 })
      .customer("u")
      .recordUsage(aiCredits, 1, { idempotencyKey: "k1" })
      .catch((e: unknown) => e)) as ConnectionError;
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.name).toBe("ConnectionError");
    expect(error.cause).toBe(cause);
    expect(error.idempotencyKey).toBe("k1");
  });

  it("raises a timeout error when an attempt passes its deadline", async () => {
    const { fetch } = fakeFetch(
      (_sent, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = (await server(fetch, { maxRetries: 0, timeout: 20 })
      .customer("u")
      .recordUsage(aiCredits, 1, { idempotencyKey: "k2" })
      .catch((e: unknown) => e)) as TimeoutError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("Entitler did not answer within 20 ms.");
    expect(error.idempotencyKey).toBe("k2");
  });

  it("takes a per-call timeout", async () => {
    const { fetch } = fakeFetch(
      (_sent, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = await server(fetch, { maxRetries: 0 })
      .customer("u")
      .check("f", { timeout: 15 })
      .catch((e: unknown) => e);
    expect((error as TimeoutError).message).toBe("Entitler did not answer within 15 ms.");
  });

  it("rethrows a caller's abort unwrapped", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(
      (_sent, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("wrapped")));
          controller.abort();
        }),
    );
    const error = await server(fetch)
      .customer("u")
      .check("f", { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("rejects at once with an already aborted signal", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    const signal = AbortSignal.abort();
    await expect(server(fetch).customer("u").check("f", { signal })).rejects.toBe(signal.reason);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries %i and answers the last attempt", async (status) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, sent } = fakeFetch(apiError(status, "unavailable"), json(checkAnswer()));
    const check = await server(fetch).customer("u").check("f");
    expect(check.entitled).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 422, 501])("never retries %i", async (status) => {
    const { fetch, sent } = fakeFetch(apiError(status, "x"), json(checkAnswer()));
    await expect(server(fetch).customer("u").check("f")).rejects.toMatchObject({ status });
    expect(sent).toHaveLength(1);
  });

  it("retries connection failures and timeouts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const { fetch, sent } = fakeFetch((_sent, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      if (calls === 2) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return json(checkAnswer());
    });
    await server(fetch, { timeout: 20 }).customer("u").check("f");
    expect(sent).toHaveLength(3);
  });

  it("stops after maxRetries with the last error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, sent } = fakeFetch(apiError(500, "internal", "first"), apiError(503, "unavailable", "last"));
    await expect(server(fetch, { maxRetries: 3 }).customer("u").check("f")).rejects.toMatchObject({
      status: 503,
      message: "last",
    });
    expect(sent).toHaveLength(4);
  });

  it("sends the same idempotency key on every attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, sent } = fakeFetch(apiError(503, "unavailable"), apiError(502, "x"), json(usageAnswer()));
    await server(fetch).customer("u").recordUsage(aiCredits, 1, { idempotencyKey: "k" });
    const keys = new Set(sent.map((request) => request.headers["idempotency-key"]));
    expect(sent).toHaveLength(3);
    expect(keys.size).toBe(1);
  });

  it("waits a full-jitter backoff within its bounds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      delays.push(ms);
      return original(fn, ms);
    }) as typeof setTimeout);
    const { fetch } = fakeFetch(apiError(503, "unavailable"));
    const result = server(fetch, { maxRetries: 5 })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    await result;
    expect(delays).toHaveLength(5);
    const caps = [500, 1000, 2000, 4000, 8000];
    delays.forEach((delay, n) => {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(caps[n] as number);
      expect(delay).toBeGreaterThan((caps[n] as number) * 0.99);
    });
  });

  it("caps the backoff at 8 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      delays.push(ms);
      return original(fn, ms);
    }) as typeof setTimeout);
    const { fetch } = fakeFetch(apiError(503, "unavailable"));
    const result = server(fetch, { maxRetries: 7 })
      .customer("u")
      .check("f")
      .catch(() => undefined);
    await vi.runAllTimersAsync();
    await result;
    expect(Math.max(...delays)).toBeLessThanOrEqual(8000);
    expect(delays.at(-1)).toBeGreaterThan(7900);
  });

  it("waits Retry-After seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      delays.push(ms);
      return original(fn, ms);
    }) as typeof setTimeout);
    const { fetch } = fakeFetch(
      apiError(429, "rate_limited", "Slow down.", { "retry-after": "3" }),
      json(checkAnswer()),
    );
    const result = server(fetch).customer("u").check("f");
    await vi.runAllTimersAsync();
    await result;
    expect(delays).toEqual([3000]);
  });

  it("waits until a Retry-After date", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-10-09T00:00:00Z") });
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      delays.push(ms);
      return original(fn, ms);
    }) as typeof setTimeout);
    const { fetch } = fakeFetch(
      apiError(503, "unavailable", "Later.", { "retry-after": "Fri, 09 Oct 2026 00:00:04 GMT" }),
      json(checkAnswer()),
    );
    const result = server(fetch).customer("u").check("f");
    await vi.runAllTimersAsync();
    await result;
    expect(delays).toEqual([4000]);
  });

  it("fails at once when Retry-After asks for longer than maxRetryDelay", async () => {
    const { fetch, sent } = fakeFetch(
      apiError(503, "unavailable", "Much later.", { "retry-after": "120" }),
      json(checkAnswer()),
    );
    const error = (await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.retryAfter).toBe(120_000);
    expect(sent).toHaveLength(1);
  });

  it("honours a larger maxRetryDelay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, sent } = fakeFetch(
      apiError(503, "unavailable", "Later.", { "retry-after": "20" }),
      json(checkAnswer()),
    );
    const result = server(fetch, { maxRetryDelay: 30_000 }).customer("u").check("f");
    await vi.runAllTimersAsync();
    await result;
    expect(sent).toHaveLength(2);
  });

  it("ignores an unreadable Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(apiError(503, "unavailable", "?", { "retry-after": "soon" }), apiError(400, "x"));
    const error = (await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(400);
  });

  it("ends a retry wait at once when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetch, sent } = fakeFetch(
      apiError(503, "unavailable", "Later.", { "retry-after": "5" }),
      json(checkAnswer()),
    );
    const started = Date.now();
    const result = server(fetch).customer("u").check("f", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await result.catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sent).toHaveLength(1);
  });

  it("validates the numeric options", () => {
    const fetch = fakeFetch(json({})).fetch;
    expect(() => server(fetch, { timeout: 0 })).toThrow(RangeError);
    expect(() => server(fetch, { maxRetries: -1 })).toThrow(RangeError);
    expect(() => server(fetch, { maxRetries: 1.5 })).toThrow(TypeError);
    expect(() => server(fetch, { maxRetryDelay: -1 })).toThrow(RangeError);
    expect(() => server(fetch, { staleFor: -1 })).toThrow(RangeError);
  });
});
