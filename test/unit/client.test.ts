import { describe, expect, it, vi } from "vitest";
import { EntitlerClient, MemoryCache, TokenError } from "../../src/index.js";
import { apiError, checkAnswer, fakeFetch, json } from "./fake.js";

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

  it("refreshes once per call, and passes a second refusal on", async () => {
    const token = vi.fn(async () => "ct_x");
    const { fetch, sent } = fakeFetch(apiError(401, "Unauthenticated", "TOKEN_INVALID"));
    const entitler = new EntitlerClient({ token, fetch });
    await expect(entitler.me.check("f")).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(2);
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("passes a fixed token's refusal on without asking again", async () => {
    const { fetch, sent } = fakeFetch(apiError(401, "Unauthenticated", "TOKEN_EXPIRED"));
    const entitler = new EntitlerClient({ token: "ct_1", fetch });
    await expect(entitler.me.check("f")).rejects.toMatchObject({ reason: "TOKEN_EXPIRED" });
    expect(sent).toHaveLength(1);
  });

  it("fails with TokenError when the provider fails, times out or answers a blank token", async () => {
    const { fetch, mock } = fakeFetch(json(checkAnswer()));
    const failing = new EntitlerClient({ token: () => Promise.reject(new Error("offline")), fetch });
    const error = await failing.me.check("f").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect(error).toMatchObject({ message: "The token provider failed.", cause: new Error("offline") });
    expect(await failing.me.isEntitled("f", { default: true })).toBe(true);
    const slow = new EntitlerClient({ token: () => new Promise<string>(() => {}), fetch, timeout: 10 });
    await expect(slow.me.check("f")).rejects.toThrow("The token provider did not answer within 10 ms.");
    const blank = new EntitlerClient({ token: () => " ", fetch });
    await expect(blank.me.check("f")).rejects.toBeInstanceOf(TokenError);
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
