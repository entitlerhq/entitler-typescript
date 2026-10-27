import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConnectionError,
  EntitlerError,
  EntitlerServer,
  isUnreachable,
  type TimeoutError,
  VERSION,
} from "../../src/index.js";
import { Transport } from "../../src/transport.js";
import { apiError, checkAnswer, fakeFetch, json } from "./fake.js";

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
    expect(request?.url).toBe("https://api.entitler.app/v1/customers/user_1/entitlements/export_pdf");
    expect(request?.headers.authorization).toBe("Bearer ent_test_secret");
    expect(request?.headers.accept).toBe("application/json");
    expect(request?.headers["content-type"]).toBeUndefined();
    expect(request?.headers["user-agent"]).toBe(`entitler-typescript/${VERSION} ${runtime}`);
    expect(request?.body).toBeUndefined();
  });

  it("sends asOf as Unix seconds", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await server(fetch)
      .customer("u")
      .check("f", { asOf: new Date("2026-10-09T01:00:00.900Z") });
    expect(sent[0]?.query).toEqual({ as_of: "1791507600" });
  });

  it("encodes path segments like encodeURIComponent", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await server(fetch).customer("google:a/b c?é").check("export pdf");
    expect(sent[0]?.url).toBe(
      "https://api.entitler.app/v1/customers/google%3Aa%2Fb%20c%3F%C3%A9/entitlements/export%20pdf",
    );
  });

  it("removes trailing slashes from the base URL", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await server(fetch, { baseUrl: "http://localhost:8787//" }).customer("u").check("f");
    expect(sent[0]?.url).toBe("http://localhost:8787/v1/customers/u/entitlements/f");
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

  it("decodes Unix seconds as dates and keeps unknown enum values", async () => {
    const { fetch } = fakeFetch(
      json(
        checkAnswer({
          kind: "ENTITLED_FEATURE_KIND_BRAND_NEW",
          meter: { used: 3, held: 0, banked: 0, resetsAt: 1_793_491_200 },
        }),
      ),
    );
    const check = await server(fetch).customer("u").check("f");
    expect(check.asOf).toEqual(new Date("2026-10-09T01:00:00.000Z"));
    expect(check.meter?.resetsAt).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(check.type).toBe("brand_new");
  });
});

describe("errors", () => {
  it("decodes the API's refusal", async () => {
    const { fetch } = fakeFetch(
      apiError(404, "NotFound", "CUSTOMER_NOT_FOUND", { "x-request-id": "req_1" }, { customer: "u" }),
    );
    const error = await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(EntitlerError);
    expect(error).toMatchObject({
      status: 404,
      code: "NotFound",
      reason: "CUSTOMER_NOT_FOUND",
      parameters: { customer: "u" },
      requestId: "req_1",
      retryAfter: undefined,
      message: "Entitler answered CUSTOMER_NOT_FOUND (HTTP 404).",
    });
  });

  it("names the gRPC code of an answer without a readable body", async () => {
    const { fetch } = fakeFetch(new Response("<html>Bad gateway</html>", { status: 403 }));
    const error = await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, code: "PermissionDenied", reason: null, parameters: {} });
  });

  it("refuses a 2xx answer it cannot read with RESPONSE_INVALID", async () => {
    const { fetch } = fakeFetch(json({ entitlement: {} }, 200, { "x-request-id": "req_2" }));
    const error = await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 200, code: "Internal", reason: "RESPONSE_INVALID", requestId: "req_2" });
    expect((error as ApiError).cause).toBeInstanceOf(TypeError);
  });

  it("wraps a failed connection", async () => {
    const { fetch } = fakeFetch(new TypeError("fetch failed"));
    const error = await server(fetch, { maxRetries: 0 })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
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
    const { fetch, sent } = fakeFetch(apiError(status, "Unavailable", "UNAVAILABLE"), json(checkAnswer()));
    const check = await server(fetch).customer("u").check("f");
    expect(check.entitled).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 422, 501])("never retries %i", async (status) => {
    const { fetch, sent } = fakeFetch(apiError(status, "InvalidArgument", "X"), json(checkAnswer()));
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
    const { fetch, sent } = fakeFetch(apiError(500, "Internal", "FAILED"), apiError(503, "Unavailable", "UNAVAILABLE"));
    await expect(server(fetch, { maxRetries: 3 }).customer("u").check("f")).rejects.toMatchObject({
      status: 503,
      reason: "UNAVAILABLE",
    });
    expect(sent).toHaveLength(4);
  });

  function transport(fetch: typeof globalThis.fetch) {
    return new Transport(
      { fetch, cache: false },
      { kind: "server", authorise: async () => ({ headers: {}, kind: "key", credential: "k" }) },
    );
  }

  it.each([
    ["a POST", { method: "POST" as const }, 1],
    ["a POST marked retryable", { method: "POST" as const, retryable: true }, 2],
    ["a PUT", { method: "PUT" as const }, 2],
    ["a DELETE", { method: "DELETE" as const }, 2],
  ])("retries %s only when repeating it is safe", async (_name, call, attempts) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, sent } = fakeFetch(apiError(503, "Unavailable", "UNAVAILABLE"), json({}));
    await transport(fetch)
      .send({ ...call, path: "/v1/x", body: {}, decode: (value) => value })
      .catch(() => undefined);
    expect(sent).toHaveLength(attempts);
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
    const { fetch } = fakeFetch(apiError(503, "Unavailable", "UNAVAILABLE"));
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
    const { fetch } = fakeFetch(apiError(503, "Unavailable", "UNAVAILABLE"));
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
      apiError(429, "ResourceExhausted", "API_RATE_LIMITED", { "retry-after": "3" }),
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
      apiError(503, "Unavailable", "UNAVAILABLE", { "retry-after": "Fri, 09 Oct 2026 00:00:04 GMT" }),
      json(checkAnswer()),
    );
    const result = server(fetch).customer("u").check("f");
    await vi.runAllTimersAsync();
    await result;
    expect(delays).toEqual([4000]);
  });

  it("fails at once when Retry-After asks for longer than maxRetryDelay", async () => {
    const { fetch, sent } = fakeFetch(
      apiError(503, "Unavailable", "UNAVAILABLE", { "retry-after": "120" }),
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
      apiError(503, "Unavailable", "UNAVAILABLE", { "retry-after": "20" }),
      json(checkAnswer()),
    );
    const result = server(fetch, { maxRetryDelay: 30_000 }).customer("u").check("f");
    await vi.runAllTimersAsync();
    await result;
    expect(sent).toHaveLength(2);
  });

  it("ignores an unreadable Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(
      apiError(503, "Unavailable", "UNAVAILABLE", { "retry-after": "soon" }),
      apiError(400, "InvalidArgument", "X"),
    );
    const error = (await server(fetch)
      .customer("u")
      .check("f")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(400);
  });

  it("ends a retry wait at once when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetch, sent } = fakeFetch(
      apiError(503, "Unavailable", "UNAVAILABLE", { "retry-after": "5" }),
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

describe("the client", () => {
  it("shows its base URL and kind, never its key", () => {
    const entitler = new EntitlerServer({ key: "ky_secret", baseUrl: "https://dev.entitler.dev" });
    expect(String(entitler)).toBe("EntitlerServer { baseUrl: https://dev.entitler.dev, kind: server }");
    expect(JSON.stringify(entitler)).toBe('{"baseUrl":"https://dev.entitler.dev","kind":"server"}');
    const inspect = (entitler as unknown as Record<symbol, () => string>)[Symbol.for("nodejs.util.inspect.custom")];
    expect(inspect?.call(entitler)).toBe(String(entitler));
  });

  it("refuses a blank key and a blank customer id", () => {
    expect(() => new EntitlerServer({ key: " " })).toThrow("Provide an Entitler key from the dashboard.");
    expect(() => new EntitlerServer({ key: "k" }).customer("")).toThrow(
      "Provide the id your app uses for the customer.",
    );
  });

  it("refuses calls once closed", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    const entitler = server(fetch);
    entitler.close();
    entitler.close();
    await expect(entitler.customer("u").check("f")).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("answers whether an error means Entitler was unreachable", () => {
    expect(isUnreachable(new ConnectionError("down"))).toBe(true);
    expect(isUnreachable(new ApiError({ status: 503, code: "Unavailable", reason: null }))).toBe(true);
    expect(isUnreachable(new ApiError({ status: 408, code: "Unknown", reason: null }))).toBe(true);
    expect(isUnreachable(new ApiError({ status: 404, code: "NotFound", reason: "CUSTOMER_NOT_FOUND" }))).toBe(false);
    expect(isUnreachable(new Error("other"))).toBe(false);
  });
});
