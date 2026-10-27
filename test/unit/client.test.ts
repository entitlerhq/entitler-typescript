import { describe, expect, it, vi } from "vitest";
import { defineFeature, EntitlerClient, isUnreachable, MemoryCache, TokenError } from "../../src/index.js";
import { apiError, checkAnswer, fakeFetch, json, usageAnswer } from "./fake.js";

const registered = {
  customer: {
    id: "cu_1",
    externalId: "auth0:ada",
    attributes: [],
    money: "CUSTOMER_MONEY_REAL",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  created: true,
};

describe("EntitlerClient", () => {
  it("checks the signed-in customer with a customer token", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const entitler = new EntitlerClient({ token: "ct_1", fetch });
    expect(await entitler.me.isEntitled("export_pdf", { default: false })).toBe(true);
    expect(sent[0]?.path).toBe("/v1/customers/me/entitlements/export_pdf");
    expect(sent[0]?.headers.authorization).toBe("Bearer ct_1");
    expect(entitler.kind).toBe("token");
  });

  it("signs in with a publishable key and an identity token, and registers the customer", async () => {
    const { fetch, sent } = fakeFetch(json(registered));
    const entitler = new EntitlerClient({ key: "ky_pub", identityToken: "id.jwt.token", fetch });
    expect((await entitler.register()).created).toBe(true);
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/v1/customers/me", body: {} });
    expect(sent[0]?.headers.authorization).toBe("Bearer ky_pub");
    expect(sent[0]?.headers["entitler-identity-token"]).toBe("id.jwt.token");
    expect(entitler.kind).toBe("identity");
  });

  it("asks the provider once for concurrent calls, and again once Entitler refuses the token", async () => {
    let issued = 0;
    const token = vi.fn(async () => `ct_${++issued}`);
    const { fetch, sent } = fakeFetch((request) =>
      request.headers.authorization === "Bearer ct_1"
        ? apiError(401, "Unauthenticated", "TOKEN_EXPIRED")
        : json(checkAnswer()),
    );
    const entitler = new EntitlerClient({ token, fetch, cache: false });
    await Promise.all([entitler.me.check("a"), entitler.me.check("b")]);
    expect(token).toHaveBeenCalledTimes(2);
    expect(sent.map((request) => request.headers.authorization)).toEqual([
      "Bearer ct_1",
      "Bearer ct_1",
      "Bearer ct_2",
      "Bearer ct_2",
    ]);
  });

  it("keeps the answer to a refreshed read under the new token", async () => {
    let issued = 0;
    const { fetch, sent } = fakeFetch((request) =>
      request.headers.authorization === "Bearer ct_1"
        ? apiError(401, "Unauthenticated", "TOKEN_EXPIRED")
        : json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "private, max-age=60" }),
    );
    const entitler = new EntitlerClient({ token: async () => `ct_${++issued}`, fetch });
    await entitler.me.check("a");
    await entitler.me.check("a");
    expect(sent).toHaveLength(2);
  });

  it("sends a refused write again, once, with the new token and the same body", async () => {
    let issued = 0;
    const { fetch, sent } = fakeFetch((request) =>
      request.headers.authorization === "Bearer ct_1"
        ? apiError(401, "Unauthenticated", "TOKEN_EXPIRED")
        : json(usageAnswer()),
    );
    const entitler = new EntitlerClient({ token: async () => `ct_${++issued}`, fetch });
    await entitler.me.recordUsage(defineFeature("ai_credits", "metered"), 1, { idempotencyKey: "job-1" });
    expect(sent.map((request) => request.headers.authorization)).toEqual(["Bearer ct_1", "Bearer ct_2"]);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
  });

  it("refreshes once per call, and passes a second refusal on", async () => {
    let issued = 0;
    const token = vi.fn(async () => `ct_${++issued}`);
    const { fetch, sent } = fakeFetch(apiError(401, "Unauthenticated", "TOKEN_INVALID"));
    const entitler = new EntitlerClient({ token, fetch });
    await expect(entitler.me.check("f")).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(2);
    expect(token).toHaveBeenCalledTimes(2);
    await expect(entitler.me.check("f")).rejects.toMatchObject({ status: 401 });
    expect(sent[2]?.headers.authorization).toBe("Bearer ct_3");
  });

  it("keeps a refused token out when the call that asked again was cancelled", async () => {
    let answer: ((token: string) => void) | undefined;
    let asked = 0;
    const token = () => (++asked === 2 ? new Promise<string>((resolve) => (answer = resolve)) : `ct_${asked}`);
    const { fetch, sent } = fakeFetch((request) =>
      request.headers.authorization === "Bearer ct_1"
        ? apiError(401, "Unauthenticated", "TOKEN_EXPIRED")
        : json(checkAnswer()),
    );
    const entitler = new EntitlerClient({ token, fetch });
    const controller = new AbortController();
    const call = entitler.me.check("f", { signal: controller.signal });
    await vi.waitFor(() => expect(answer).toBeDefined());
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    answer?.("ct_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await entitler.me.check("f");
    expect(sent.map((request) => request.headers.authorization)).toEqual(["Bearer ct_1", "Bearer ct_3"]);
  });

  it("never sends a refused token the provider answers again, nor keeps it", async () => {
    const token = vi.fn(async () => "ct_x");
    const { fetch, sent } = fakeFetch(apiError(401, "Unauthenticated", "TOKEN_INVALID"));
    const entitler = new EntitlerClient({ token, fetch });
    await expect(entitler.me.check("f")).rejects.toBeInstanceOf(TokenError);
    await expect(entitler.me.check("f")).rejects.toBeInstanceOf(TokenError);
    expect(sent).toHaveLength(1);
    expect(token).toHaveBeenCalledTimes(3);
  });

  it("remembers every refused token, not only the latest", async () => {
    const tokens = ["ct_1", "ct_2", "ct_1"];
    const { fetch, sent } = fakeFetch(apiError(401, "Unauthenticated", "TOKEN_EXPIRED"));
    const entitler = new EntitlerClient({ token: async () => tokens.shift() as string, fetch });
    await expect(entitler.me.check("a")).rejects.toMatchObject({ status: 401 });
    await expect(entitler.me.check("a")).rejects.toBeInstanceOf(TokenError);
    expect(sent.map((request) => request.headers.authorization)).toEqual(["Bearer ct_1", "Bearer ct_2"]);
  });

  it("answers a kept entry as stale when the provider fails after a refusal", async () => {
    let asked = 0;
    const token = async () => {
      if (++asked > 1) throw new Error("offline");
      return "ct_1";
    };
    let served = false;
    const { fetch } = fakeFetch(() => {
      if (served) return apiError(401, "Unauthenticated", "TOKEN_EXPIRED");
      served = true;
      return json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "private, max-age=0" });
    });
    const entitler = new EntitlerClient({ token, fetch, onError: () => {} });
    expect((await entitler.me.check("a")).stale).toBe(false);
    expect((await entitler.me.check("a")).stale).toBe(true);
    expect((await entitler.me.check("a")).stale).toBe(true);
  });

  it("passes a fixed token's refusal on without asking again", async () => {
    const { fetch, sent } = fakeFetch(apiError(401, "Unauthenticated", "TOKEN_EXPIRED"));
    const entitler = new EntitlerClient({ token: "ct_1", fetch });
    await expect(entitler.me.check("f")).rejects.toMatchObject({ reason: "TOKEN_EXPIRED" });
    expect(sent).toHaveLength(1);
  });

  it("fails with TokenError, counted unreachable only when the provider fails or times out", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    const failing = new EntitlerClient({ token: () => Promise.reject(new Error("offline")), fetch });
    const error = await failing.me.check("f").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({ message: "The token provider failed.", cause: new Error("offline") });
    expect(isUnreachable(error)).toBe(true);
    const silent = new EntitlerClient({ token: () => Promise.reject(undefined), fetch });
    expect(isUnreachable(await silent.me.check("f").catch((e: unknown) => e))).toBe(true);
    expect(await failing.me.isEntitled("f", { default: true })).toBe(true);
    const slow = new EntitlerClient({ token: () => new Promise<string>(() => {}), fetch, timeout: 10 });
    const late = await slow.me.check("f").catch((e: unknown) => e);
    expect(late).toMatchObject({ message: "The token provider did not answer within 10 ms." });
    expect(isUnreachable(late)).toBe(true);
    const blank = new EntitlerClient({ token: () => " ", fetch });
    const refused = await blank.me.check("f").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TokenError);
    expect(isUnreachable(refused)).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it("aborts the pending token request at close", async () => {
    let seen: AbortSignal | undefined;
    const { fetch } = fakeFetch(json(checkAnswer()));
    const entitler = new EntitlerClient({
      token: ({ signal }) => {
        seen = signal;
        return new Promise<string>(() => {});
      },
      fetch,
    });
    const call = entitler.me.check("f");
    await vi.waitFor(() => expect(seen).toBeDefined());
    entitler.close();
    await expect(call).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(seen?.aborted).toBe(true);
  });

  it("refuses missing or mixed credentials, and a shared cache store", () => {
    const loose = EntitlerClient as unknown as new (options: unknown) => EntitlerClient;
    for (const options of [{}, { key: "k" }, { token: "t", key: "k" }, { identityToken: "i" }, undefined]) {
      expect(() => new loose(options)).toThrow("Create the client with { token } or { key, identityToken }.");
    }
    expect(() => new loose({ token: "t", cache: { get() {}, set() {} } })).toThrow(TypeError);
    expect(() => new EntitlerClient({ token: "t", cache: new MemoryCache({ maxEntries: 5 }) })).not.toThrow();
  });

  it("shows its base URL and kind, never the credential", () => {
    const entitler = new EntitlerClient({ token: "ct_secret", baseUrl: "https://staging.entitler.dev/" });
    expect(String(entitler)).toBe("EntitlerClient { baseUrl: https://staging.entitler.dev, kind: token }");
    expect(JSON.stringify(entitler)).toBe('{"baseUrl":"https://staging.entitler.dev","kind":"token"}');
    expect(JSON.stringify(entitler)).not.toContain("ct_secret");
  });
});
