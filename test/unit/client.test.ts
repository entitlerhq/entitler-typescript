import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  MemoryCache,
  newVisitorId,
  TokenError,
  VISITOR_ID_PATTERN,
} from "../../src/index.js";
import { apiError, checkAnswer, fakeFetch, json, jwt } from "./fake.js";

const aiCredits = defineFeature("ai_credits", "metered");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const WAYS_IN = "Create the client with { token }, { key, identityToken } or { key }.";
const token = (claims: Record<string, unknown> = {}) =>
  jwt({
    iss: "https://api.entitler.dev/customers",
    eid: "env_1",
    sub: "u",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });

describe("construction", () => {
  it("validates the server key", () => {
    for (const key of ["", "   ", undefined, 3]) {
      expect(() => new EntitlerServer({ key } as never)).toThrow(
        new TypeError("Provide an Entitler API key from the dashboard."),
      );
    }
    expect(() => new EntitlerServer(undefined as never)).toThrow(TypeError);
  });

  it("validates a customer id", () => {
    const server = new EntitlerServer({ key: "k" });
    expect(() => server.customer(" ")).toThrow(new TypeError("Provide the id your app uses for the customer."));
    expect(server.customer(" user_1 ").id).toBe(" user_1 ");
  });

  it.each([
    [{}],
    [{ token: "t", key: "k", identityToken: "i" }],
    [{ token: "t", key: "k" }],
    [{ token: "t", identityToken: "i" }],
    [{ identityToken: "i" }],
    [undefined],
  ])("refuses %j", (options) => {
    expect(() => new EntitlerClient(options as never)).toThrow(new TypeError(WAYS_IN));
  });

  it("validates each credential", () => {
    expect(() => new EntitlerClient({ token: " " })).toThrow(
      new TypeError("Provide a customer token minted by your server."),
    );
    expect(() => new EntitlerClient({ key: "", identityToken: "i" })).toThrow(
      new TypeError("Provide an Entitler API key from the dashboard."),
    );
    expect(() => new EntitlerClient({ key: "k", identityToken: "" })).toThrow(
      new TypeError("Provide the identity token your sign-in provider issued."),
    );
    expect(() => new EntitlerClient({ token: () => "" })).not.toThrow();
  });

  it("refuses each key kind in the other client, after blank values", () => {
    expect(() => new EntitlerServer({ key: " ent_pk_live_abc " })).toThrow(
      new TypeError("A publishable key belongs in EntitlerClient. Use a secret key from the dashboard on your server."),
    );
    const secret = new TypeError(
      "A secret key belongs on your server, in EntitlerServer. Use a publishable key (ent_pk_…) in an app.",
    );
    expect(() => new EntitlerClient({ key: "ent_live_abc" })).toThrow(secret);
    expect(() => new EntitlerClient({ key: "ent_test_abc", identityToken: "idt" })).toThrow(secret);
    expect(() => new EntitlerClient({ key: " ", identityToken: "idt" })).toThrow(
      new TypeError("Provide an Entitler API key from the dashboard."),
    );
    expect(() => new EntitlerClient({ key: "ent_live_abc", identityToken: " " })).toThrow(
      new TypeError("Provide the identity token your sign-in provider issued."),
    );
    expect(new EntitlerClient({ key: "ent_pk_test_abc" }).kind).toBe("publishable");
  });

  it("refuses a custom store in an in-app client", () => {
    const store = { get: () => undefined, set: () => undefined };
    expect(() => new EntitlerClient({ token: "t", cache: store as never })).toThrow(
      new TypeError("In-app clients keep answers in memory: pass a cache size, or turn the cache off."),
    );
    expect(() => new EntitlerClient({ token: "t", cache: new MemoryCache({ maxEntries: 5 }) })).not.toThrow();
    expect(() => new EntitlerClient({ token: "t", cache: false })).not.toThrow();
  });

  it("validates asOf on server reads before any request", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    for (const asOf of ["yesterday", "2026-13-01T00:00:00Z", "2026-07-01", new Date(Number.NaN)]) {
      await expect(customer.check("f", { asOf })).rejects.toThrow(new TypeError("Pass asOf as a valid date."));
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("validates a given visitor", () => {
    expect(() => new EntitlerClient({ token: "t", visitor: "short" })).toThrow(
      new TypeError("Pass visitor as an id of 16 to 64 letters, numbers, hyphens or underscores."),
    );
  });
});

describe("string forms", () => {
  it("show the base URL and kind, never the credential", () => {
    const secret = "ent_test_supersecret";
    const clients = [
      new EntitlerServer({ key: secret }),
      new EntitlerClient({ token: secret }),
      new EntitlerClient({ key: `ent_pk_${secret}`, identityToken: secret }),
    ];
    for (const client of clients) {
      for (const text of [
        String(client),
        JSON.stringify(client),
        inspect(client),
        inspect(client, { showHidden: true }),
      ]) {
        expect(text).not.toContain(secret);
        expect(text).toContain("https://api.entitler.dev");
      }
    }
    expect(String(clients[1])).toBe("EntitlerClient { baseUrl: https://api.entitler.dev, kind: token }");
    expect(clients[2]?.toJSON()).toEqual({ baseUrl: "https://api.entitler.dev", kind: "identity" });
    expect(String(clients[0])).toBe("EntitlerServer { baseUrl: https://api.entitler.dev, kind: server }");
  });

  it("answers instanceof and kind", () => {
    const client = new EntitlerClient({ token: "t" });
    expect(client).toBeInstanceOf(EntitlerClient);
    expect(client.kind).toBe("token");
  });
});

describe("credentials on the wire", () => {
  it("sends a customer token as the bearer and uses /customers/me", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer({ customer: "user_9" })));
    const client = new EntitlerClient({ token: "tok", fetch });
    expect(client.me.id).toBeUndefined();
    await client.me.check("f");
    expect(sent[0]?.path).toBe("/customers/me/entitlements/f");
    expect(sent[0]?.headers.authorization).toBe("Bearer tok");
    expect(sent[0]?.headers["entitler-identity-token"]).toBeUndefined();
    expect(client.me.id).toBe("user_9");
  });

  it("sends the publishable key and the identity token on every request", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ key: "ent_pk_test_1", identityToken: "idt", fetch });
    await client.me.check("f");
    expect(sent[0]?.headers.authorization).toBe("Bearer ent_pk_test_1");
    expect(sent[0]?.headers["entitler-identity-token"]).toBe("idt");
  });

  it("registers an identity customer with PUT /customers/me and no body", async () => {
    const { fetch, sent } = fakeFetch(
      json(
        { id: "cus_1", externalId: "google:1", environmentId: "e", createdAt: "2026-10-09T00:00:00Z", created: true },
        201,
      ),
    );
    const client = new EntitlerClient({ key: "ent_pk_test_a", identityToken: "idt", fetch });
    const registered = await client.register({ idempotencyKey: "reg-1" });
    expect(registered.createdAt).toBeInstanceOf(Date);
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/customers/me", body: undefined });
    expect(sent[0]?.headers["idempotency-key"]).toBe("reg-1");
    expect(sent[0]?.headers["content-type"]).toBeUndefined();
  });

  it("sends register from a token client, which the API refuses", async () => {
    const { fetch, sent } = fakeFetch(apiError(403, "credential_not_allowed"));
    const client = new EntitlerClient({ token: "t", fetch });
    // @ts-expect-error register needs an identity-token client
    await expect(client.register()).rejects.toMatchObject({ code: "credential_not_allowed" });
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/customers/me" });
  });

  it("sends no credential, visitor or as-of to the snapshot keys, and never asks a provider", async () => {
    const { fetch, sent } = fakeFetch(json({ keys: [] }));
    const provider = vi.fn(() => {
      throw new Error("offline");
    });
    await new EntitlerClient({ token: provider, fetch }).snapshotKeys();
    expect(provider).not.toHaveBeenCalled();
    await new EntitlerClient({ key: "ent_pk_test_a", identityToken: "idt", fetch }).snapshotKeys();
    await new EntitlerServer({ key: "k", fetch }).snapshotKeys();
    for (const request of sent) {
      expect(request.path).toBe("/customers/snapshot-keys");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["entitler-identity-token"]).toBeUndefined();
      expect(request.headers["entitler-visitor"]).toBeUndefined();
      expect(request.headers["entitler-as-of"]).toBeUndefined();
    }
  });

  it("sends Entitler-As-Of only on the server reads given it, as UTC with milliseconds", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const server = new EntitlerServer({ key: "k", fetch, cache: false });
    const customer = server.customer("u");
    await customer.check("f", { asOf: "2026-07-01T19:30:00+10:00" });
    await customer.entitlements({ asOf: new Date("2026-07-01T09:30:00Z") });
    await customer.check("f");
    await customer.recordUsage(aiCredits, 1, { idempotencyKey: "k", asOf: "2026-07-01T09:30:00Z" } as never);
    await server.pricing({ asOf: "2026-07-01T09:30:00Z" } as never);
    await new EntitlerClient({ token: "t", fetch }).me.check("f", { asOf: "2026-07-01T09:30:00Z" } as never);
    expect(sent.map((request) => request.headers["entitler-as-of"])).toEqual([
      "2026-07-01T09:30:00.000Z",
      "2026-07-01T09:30:00.000Z",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("token providers", () => {
  it("asks the provider for the first request and keeps the answer", async () => {
    const provider = vi.fn((_context: { signal: AbortSignal }) => token());
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await client.me.check("f");
    await client.me.check("f");
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(sent[1]?.headers.authorization).toBe(`Bearer ${provider.mock.results[0]?.value}`);
  });

  it("refreshes a token that expires within 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000_000 });
    const provider = vi.fn(() => token({ exp: Math.floor(Date.now() / 1000) + 120 }));
    const { fetch } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await client.me.check("f");
    vi.setSystemTime(1_000_000_000 + 59_000);
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000_000 + 61_000);
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("refreshes once after a 401 and retries with the new token", async () => {
    let n = 0;
    const provider = vi.fn(() => token({ n: ++n }));
    const { fetch, sent } = fakeFetch(apiError(401, "unauthorised"), json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await client.me.check("f");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers.authorization).not.toBe(sent[1]?.headers.authorization);
  });

  it("fails after a second 401", async () => {
    const provider = vi.fn(() => token());
    const { fetch, sent } = fakeFetch(apiError(401, "unauthorised"));
    await expect(new EntitlerClient({ token: provider, fetch }).me.check("f")).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(2);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("fails a fixed token at the first 401", async () => {
    const { fetch, sent } = fakeFetch(apiError(401, "unauthorised"));
    await expect(new EntitlerClient({ token: "fixed", fetch }).me.check("f")).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(1);
  });

  it("never refreshes on 403 credential_not_allowed", async () => {
    const provider = vi.fn(() => token());
    const { fetch, sent } = fakeFetch(apiError(403, "credential_not_allowed"));
    await expect(new EntitlerClient({ token: provider, fetch }).me.check("f")).rejects.toMatchObject({
      code: "credential_not_allowed",
    });
    expect(sent).toHaveLength(1);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("shares one refresh between concurrent calls", async () => {
    let resolve: (value: string) => void = () => {};
    const provider = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    const calls = Promise.all([
      client.me.check("a"),
      client.me.check("b"),
      client.me.entitlements().catch(() => undefined),
    ]);
    await Promise.resolve();
    resolve(token());
    await calls;
    expect(provider).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(3);
  });

  it("shares one refresh after concurrent 401s", async () => {
    const tokens = [token({ n: 1 }), token({ n: 2 }), token({ n: 3 })];
    let n = 0;
    const provider = vi.fn(async () => tokens[n++] as string);
    const { fetch, sent } = fakeFetch((request) =>
      request.headers.authorization === `Bearer ${tokens[0]}` ? apiError(401, "unauthorised") : json(checkAnswer()),
    );
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    await Promise.all([client.me.check("a"), client.me.check("b"), client.me.check("c")]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sent.filter((request) => request.headers.authorization === `Bearer ${tokens[1]}`)).toHaveLength(3);
  });

  it("wraps a failing provider in a TokenError carrying the cause", async () => {
    const cause = new Error("server down");
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    const error = await new EntitlerClient({
      token: () => {
        throw cause;
      },
      fetch,
    }).me
      .check("f")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).cause).toBe(cause);
    expect((error as TokenError).name).toBe("TokenError");
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank", "  "],
    ["a non-string", 42],
    ["an unreadable", "not-a-jwt"],
  ])("refuses %s token without showing it", async (_name, answer) => {
    const { fetch } = fakeFetch(json(checkAnswer()));
    const error = (await new EntitlerClient({ token: () => answer as string, fetch }).me
      .check("f")
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(TokenError);
    expect(error.message).not.toContain("not-a-jwt");
  });

  it("refreshes an identity token after a 401", async () => {
    const provider = vi.fn(() =>
      jwt({ iss: "https://idp.example", sub: "a", r: Math.random(), exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    const { fetch, sent } = fakeFetch(apiError(401, "unauthorised"), json(checkAnswer()));
    await new EntitlerClient({ key: "ent_pk_test_a", identityToken: provider, fetch }).me.check("f");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sent[1]?.headers.authorization).toBe("Bearer ent_pk_test_a");
  });

  it("lets a caller abort a pending refresh", async () => {
    const controller = new AbortController();
    const client = new EntitlerClient({ token: () => new Promise<string>(() => {}) });
    const call = client.me.check("f", { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toBe(controller.signal.reason);
  });

  it("passes a provider's own abort through", async () => {
    const controller = new AbortController();
    const client = new EntitlerClient({
      token: ({ signal }) =>
        new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    });
    const call = client.me.check("f", { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toBe(controller.signal.reason);
  });
});

describe("scopes", () => {
  it("keeps the known scopes in the SDK's order", async () => {
    const { fetch, sent } = fakeFetch(
      json({
        id: "k",
        scopes: ["usage:write", "plans:publish", "plans:read", "brand:new", "tracks:assign"],
        registration: true,
      }),
    );
    const scopes = await new EntitlerServer({ key: "k", fetch }).scopes();
    expect(scopes).toEqual({ scopes: ["plans:read", "usage:write", "tracks:assign"] });
    expect(sent[0]?.path).toBe("/keys/self");
  });

  it("exposes registration for an identity client", async () => {
    const { fetch, sent } = fakeFetch(
      json({ scopes: ["entitlements:read", "customers:register"], registration: false }),
    );
    const scopes = await new EntitlerClient({ key: "ent_pk_test_a", identityToken: "idt", fetch }).scopes();
    expect(scopes).toEqual({ scopes: ["entitlements:read", "customers:register"], registration: false });
    expect(sent[0]?.headers["entitler-identity-token"]).toBe("idt");
  });

  it("answers a customer token's scopes", async () => {
    const { fetch } = fakeFetch(json({ customer: "u", scopes: ["usage:read"], expiresAt: "2026-10-09T02:00:00Z" }));
    expect(await new EntitlerClient({ token: "t", fetch }).scopes()).toEqual({ scopes: ["usage:read"] });
  });

  it("never holds a request back waiting on scopes", async () => {
    const { fetch, sent } = fakeFetch(apiError(403, "scope_required"));
    await expect(new EntitlerServer({ key: "k", fetch }).customer("u").grant("sso")).rejects.toMatchObject({
      code: "scope_required",
    });
    expect(sent.map((request) => request.path)).toEqual(["/customers/u/grants"]);
  });
});

describe("visitors", () => {
  it("mints ids of 32 base64url characters", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newVisitorId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(VISITOR_ID_PATTERN.test(id)).toBe(true);
    }
    expect(new EntitlerServer({ key: "k" }).newVisitorId()).toMatch(VISITOR_ID_PATTERN);
  });

  it("never sends a visitor from the server unless given", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const server = new EntitlerServer({ key: "k", fetch, cache: false });
    await server.customer("u").check("f");
    await server.pricing();
    await server.customer("u").register();
    expect(sent.every((request) => request.headers["entitler-visitor"] === undefined)).toBe(true);
    const visitor = newVisitorId();
    await server.pricing({ visitor });
    await server.customer("u").pricing({ visitor });
    await server.customer("u").register({ visitor });
    expect(sent.slice(3).map((request) => request.headers["entitler-visitor"])).toEqual([visitor, visitor, visitor]);
  });

  it("generates one visitor per in-app client and sends it on every request", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: "t", fetch, cache: false });
    expect(client.visitor).toMatch(VISITOR_ID_PATTERN);
    await client.me.check("f");
    await client.me.recordUsage(aiCredits, 1, { idempotencyKey: "k" });
    await client.snapshotKeys();
    expect(sent.map((request) => request.headers["entitler-visitor"])).toEqual([
      client.visitor,
      client.visitor,
      undefined,
    ]);
    expect(new EntitlerClient({ token: "t" }).visitor).not.toBe(client.visitor);
  });

  it("uses a given visitor", async () => {
    const visitor = "given_visitor_0001";
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    await new EntitlerClient({ token: "t", fetch, visitor }).me.check("f");
    expect(sent[0]?.headers["entitler-visitor"]).toBe(visitor);
  });

  describe("in a browser", () => {
    function browser(storage: Partial<Storage>) {
      vi.stubGlobal("document", {});
      vi.stubGlobal("localStorage", storage);
    }

    it("keeps a generated visitor in localStorage, written only when a call sends it", async () => {
      const store = new Map<string, string>();
      const setItem = vi.fn((key: string, value: string) => void store.set(key, value));
      browser({ getItem: (key) => store.get(key) ?? null, setItem });
      const { fetch } = fakeFetch(json(checkAnswer()));
      const client = new EntitlerClient({ token: "t", fetch, cache: false });
      expect(setItem).not.toHaveBeenCalled();
      await client.me.check("f");
      await client.me.check("f");
      expect(setItem).toHaveBeenCalledOnce();
      expect(store.get("entitler.visitor")).toBe(client.visitor);
      expect(new EntitlerClient({ token: "t" }).visitor).toBe(client.visitor);
    });

    it("leaves storage alone with a given visitor", async () => {
      const getItem = vi.fn(() => null);
      const setItem = vi.fn();
      browser({ getItem, setItem });
      const { fetch } = fakeFetch(json(checkAnswer()));
      await new EntitlerClient({ token: "t", fetch, visitor: "given_visitor_0001" }).me.check("f");
      expect(getItem).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    });

    it("replaces a stored id that is not a visitor id", () => {
      browser({ getItem: () => "bad", setItem: () => {} });
      expect(new EntitlerClient({ token: "t" }).visitor).toMatch(VISITOR_ID_PATTERN);
    });

    it("falls back to an in-memory id when storage refuses access", async () => {
      browser({
        getItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
      });
      const { fetch, sent } = fakeFetch(json(checkAnswer()));
      const client = new EntitlerClient({ token: "t", fetch });
      await client.me.check("f");
      expect(sent[0]?.headers["entitler-visitor"]).toBe(client.visitor);
    });

    it("falls back when reading localStorage itself throws", () => {
      vi.stubGlobal("document", {});
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
      try {
        expect(new EntitlerClient({ token: "t" }).visitor).toMatch(VISITOR_ID_PATTERN);
      } finally {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    });
  });
});

describe("the publishable-key client", () => {
  it("reads signed-out pricing with its visitor, and has no signed-in members", async () => {
    const { fetch, sent } = fakeFetch(
      json({ ...checkAnswer(), customer: null, defaultPlan: null, products: [], plans: [] }),
    );
    const client = new EntitlerClient({ key: "ent_pk_test_abc", fetch });
    expect((await client.pricing()).stale).toBe(false);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/pricing" });
    expect(sent[0]?.headers.authorization).toBe("Bearer ent_pk_test_abc");
    expect(sent[0]?.headers["entitler-visitor"]).toBe(client.visitor);
    const signIn = new TypeError(
      "Sign the customer in first: create the client with { token } or { key, identityToken }.",
    );
    const anyClient = client as unknown as { me: unknown; scopes(): Promise<unknown>; register(): Promise<unknown> };
    expect(() => anyClient.me).toThrow(signIn);
    await expect(anyClient.scopes()).rejects.toThrow(signIn);
    await expect(anyClient.register()).rejects.toThrow(signIn);
    const signedIn = new EntitlerClient({ token: "t", fetch }) as unknown as { pricing(): Promise<unknown> };
    await expect(signedIn.pricing()).rejects.toThrow(
      new TypeError("Read the signed-in customer's pricing with me.pricing()."),
    );
  });
});

describe("closing", () => {
  it("cancels calls in flight and the pending refresh, then refuses every call", async () => {
    const { fetch } = fakeFetch(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const server = new EntitlerServer({ key: "k", fetch });
    const inFlight = server.customer("u").check("f");
    server.close();
    const error = await inFlight.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "InvalidStateError",
      message: "This Entitler client is closed. Create a new one.",
    });
    await expect(server.customer("u").check("f")).rejects.toMatchObject({ name: "InvalidStateError" });
    await expect(server.customer("u").isEntitled("f", { default: true })).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    expect(() => server.close()).not.toThrow();

    const provider = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const client = new EntitlerClient({ token: provider, fetch });
    const waiting = client.me.check("f");
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    client.close();
    await expect(waiting).rejects.toMatchObject({ name: "InvalidStateError" });
    await expect(client.snapshotKeys()).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("drops the in-memory cache and leaves a custom store and an injected fetch as they are", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer(), 200, { "cache-control": "max-age=60", etag: '"a"' }));
    const store = new Map<string, unknown>();
    const custom = {
      get: (key: string) => store.get(key) as never,
      set: (key: string, entry: unknown) => void store.set(key, entry),
    };
    const server = new EntitlerServer({ key: "k", fetch, cache: custom });
    await server.customer("u").check("f");
    server.close();
    expect(store.size).toBe(1);
    const next = new EntitlerServer({ key: "k", fetch, cache: custom });
    await next.customer("u").check("f");
    expect(mock).toHaveBeenCalledOnce();
  });
});
