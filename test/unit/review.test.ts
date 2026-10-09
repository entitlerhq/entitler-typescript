import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConnectionError,
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  TokenError,
} from "../../src/index.js";
import { apiError, checkAnswer, fakeFetch, json, jwt, usageAnswer } from "./fake.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const aiCredits = defineFeature("ai_credits", "metered");
const kept = { etag: '"v1"', "cache-control": "private, no-cache" };

function redirect(status: number) {
  return new Response(null, { status, headers: { location: "https://evil.example/steal" } });
}

describe("redirects", () => {
  it.each([301, 302, 303, 307, 308])(
    "never follows a %i, for any credential, and fails with http_error",
    async (status) => {
      const clients = [
        new EntitlerServer({ key: "k", fetch: fakeFetch(redirect(status)).fetch, cache: false }),
        new EntitlerClient({ token: "t", fetch: fakeFetch(redirect(status)).fetch, cache: false }),
        new EntitlerClient({
          key: "ent_pk_test_a",
          identityToken: "idt",
          fetch: fakeFetch(redirect(status)).fetch,
          cache: false,
        }),
      ];
      for (const client of clients) {
        const customer = client instanceof EntitlerServer ? client.customer("u") : client.me;
        for (const call of [
          () => customer.check("f"),
          () => customer.recordUsage(aiCredits, 1, { idempotencyKey: "k" }),
        ]) {
          const error = await call().catch((e: unknown) => e);
          expect(error).toBeInstanceOf(ApiError);
          expect(error).toMatchObject({
            status,
            code: "http_error",
            message: `Entitler answered with HTTP ${status}.`,
          });
        }
      }
    },
  );

  it("asks fetch not to follow redirects and fails an opaque redirect", async () => {
    const opaque = { type: "opaqueredirect", status: 0, headers: new Headers(), body: null, text: async () => "" };
    const { fetch, mock, sent } = fakeFetch(() => opaque as unknown as Response);
    const error = await new EntitlerServer({ key: "k", fetch, cache: false })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect((mock.mock.calls[0]?.[1] as RequestInit | undefined)?.redirect).toBe("manual");
    expect(error).toMatchObject({ code: "http_error" });
    expect(sent.every((request) => request.url.startsWith("https://api.entitler.dev/"))).toBe(true);
  });
});

describe("onError that throws", () => {
  const throwing = () => {
    throw new Error("logger broke");
  };

  it("changes nothing for an isEntitled default", async () => {
    const { fetch } = fakeFetch(apiError(404, "feature_not_found"));
    const customer = new EntitlerServer({ key: "k", fetch, onError: throwing }).customer("u");
    expect(await customer.isEntitled("f", { default: true })).toBe(true);
  });

  it("changes nothing for a stale answer", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = fakeFetch(json(checkAnswer(), 200, kept), apiError(503, "unavailable"));
    const customer = new EntitlerServer({ key: "k", fetch, onError: throwing, maxRetries: 0 }).customer("u");
    await customer.check("f");
    expect((await customer.check("f")).stale).toBe(true);
  });

  it("changes nothing for a failed release", async () => {
    const { fetch } = fakeFetch((request) =>
      request.method === "DELETE"
        ? apiError(409, "hold_expired")
        : json(usageAnswer({ outcome: "held", holdId: "h", amount: 5, expiresAt: "2999-01-01T00:00:00Z" })),
    );
    const failure = new Error("work failed");
    const customer = new EntitlerServer({ key: "k", fetch, onError: throwing }).customer("u");
    await expect(customer.withHold(aiCredits, 5, () => Promise.reject(failure), { idempotencyKey: "k" })).rejects.toBe(
      failure,
    );
  });
});

describe("the write generation", () => {
  it("never keeps as fresh a read that started before a write and answered after it", async () => {
    let release: (response: Response) => void = () => {};
    let reads = 0;
    const { fetch, sent } = fakeFetch((request) => {
      if (request.method === "POST") return json(usageAnswer());
      reads += 1;
      if (reads === 1) return new Promise<Response>((resolve) => (release = resolve));
      return new Response(null, { status: 304 });
    });
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    const read = customer.check("f");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await customer.recordUsage(aiCredits, 1, { idempotencyKey: "k" });
    release(json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=60" }));
    await read;
    await customer.check("f");
    expect(sent.at(-1)?.headers["if-none-match"]).toBe('"v1"');
  });

  it("revalidates entries kept before the last write, even when it failed", async () => {
    const { fetch, sent } = fakeFetch((request) =>
      request.method === "POST"
        ? apiError(400, "not_metered")
        : request.headers["if-none-match"]
          ? new Response(null, { status: 304 })
          : json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=60" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await customer.recordUsage(aiCredits, 1, { idempotencyKey: "k" }).catch(() => undefined);
    await customer.check("f");
    expect(sent.at(-1)?.headers["if-none-match"]).toBe('"v1"');
  });

  it("leaves answers alone for writes that change none", async () => {
    const { fetch, sent } = fakeFetch((request) =>
      request.method === "POST"
        ? json({ token: jwt({ sub: "u" }), customer: "u", scopes: [], expiresAt: "2999-01-01T00:00:00Z" }, 201)
        : json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=60" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await customer.token();
    await customer.check("f");
    expect(sent).toHaveLength(2);
  });
});

describe("freshness", () => {
  it("counts the Age header in an entry's age", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=60", age: "50" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    vi.setSystemTime(5_000);
    await customer.check("f");
    expect(sent).toHaveLength(1);
    vi.setSystemTime(11_000);
    await customer.check("f");
    expect(sent).toHaveLength(2);
  });

  it("never treats no-cache as fresh, whatever its max-age", async () => {
    const { fetch, sent } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "no-cache, max-age=600" }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.check("f");
    await customer.check("f");
    expect(sent).toHaveLength(2);
  });

  it("keeps stored headers a 304 leaves out", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    const entries = new Map();
    const cache = {
      get: (key: string) => entries.get(key),
      set: (key: string, entry: unknown) => void entries.set(key, entry),
    };
    const { fetch } = fakeFetch(
      json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "max-age=10" }),
      new Response(null, { status: 304 }),
    );
    const customer = new EntitlerServer({ key: "k", fetch, cache }).customer("u");
    await customer.check("f");
    vi.setSystemTime(20_000);
    await customer.check("f");
    expect([...entries.values()][0]).toMatchObject({ etag: '"v1"', cacheControl: "max-age=10", receivedAt: 20_000 });
  });
});

describe("explicit nulls", () => {
  it("send null metadata values and omit absent options", async () => {
    const { fetch, sent } = fakeFetch(
      json({ id: "c", externalId: "u", environmentId: "e", createdAt: "2026-10-09T00:00:00Z", created: false }),
    );
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await customer.register({ name: undefined, metadata: { team: null, role: "admin" } });
    await customer.update({ metadata: { team: null } });
    expect(sent.map((request) => request.body)).toEqual([
      { metadata: { team: null, role: "admin" } },
      { metadata: { team: null } },
    ]);
  });
});

describe("path ids", () => {
  it.each([".", "..", "..."])("refuses %j", async (id) => {
    const server = new EntitlerServer({ key: "k" });
    expect(() => server.customer(id)).toThrow(new TypeError("Pass an id that is not made only of dots."));
    await expect(server.customer("u").check(id)).rejects.toThrow(
      new TypeError("Pass an id that is not made only of dots."),
    );
    await expect(server.customer("u").releaseUsage(id)).rejects.toThrow(TypeError);
    await expect(server.customer("u").cancel({ addOn: id })).rejects.toThrow(TypeError);
  });

  it("allows dots inside an id", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await new EntitlerServer({ key: "k", fetch, cache: false }).customer("a.b").check(".f");
    expect(sent[0]?.path).toBe("/customers/a.b/entitlements/.f");
  });
});

describe("token refresh edge cases", () => {
  it("keeps the shared refresh going when one waiter cancels", async () => {
    let resolve: (token: string) => void = () => {};
    const provider = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    const controller = new AbortController();
    const first = client.me.check("a", { signal: controller.signal });
    const second = client.me.check("b");
    controller.abort();
    await expect(first).rejects.toBe(controller.signal.reason);
    resolve(jwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 3600 }));
    await second;
    expect(provider).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
  });

  it("bounds a hanging provider by the client timeout, and asks again next time", async () => {
    const provider = vi.fn((): Promise<string> => new Promise(() => {}));
    const client = new EntitlerClient({ token: provider, timeout: 20 });
    const error = await client.me.check("f").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).message).toBe("The token provider did not answer within 20 ms.");
    await client.me.check("f").catch(() => undefined);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("retries 503, then 401 with a refreshed token, then answers", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let n = 0;
    const provider = vi.fn(() => jwt({ sub: "u", n: ++n, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const { fetch, sent } = fakeFetch(apiError(503, "unavailable"), apiError(401, "unauthorised"), json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false, maxRetries: 1 });
    expect((await client.me.check("f")).entitled).toBe(true);
    expect(sent).toHaveLength(3);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("never answers entries kept under the previous token when the provider fails", async () => {
    const onError = vi.fn();
    let fail = false;
    let n = 0;
    const provider = vi.fn(() => {
      if (fail) throw new Error("offline");
      const now = Math.floor(Date.now() / 1000);
      return jwt({ sub: "u", n: ++n, iat: now - 3600, exp: now + 10 });
    });
    const { fetch } = fakeFetch(json(checkAnswer(), 200, kept));
    const client = new EntitlerClient({ token: provider, fetch, onError });
    await client.me.check("f");
    fail = true;
    await expect(client.me.check("f")).rejects.toBeInstanceOf(TokenError);
    expect(await client.me.isEntitled("f", { default: false })).toBe(false);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TokenError);
  });
});

describe("answers cut off mid-read", () => {
  it("are connection errors, and retried", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const cut = {
      type: "basic",
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new TypeError("terminated")),
    };
    const { fetch, sent } = fakeFetch(() => cut as unknown as Response, json(checkAnswer()));
    expect((await new EntitlerServer({ key: "k", fetch, cache: false }).customer("u").check("f")).entitled).toBe(true);
    expect(sent).toHaveLength(2);
    const always = fakeFetch(() => cut as unknown as Response);
    const error = await new EntitlerServer({ key: "k", fetch: always.fetch, cache: false, maxRetries: 0 })
      .customer("u")
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
  });
});
