import { describe, expect, it } from "vitest";
import { EntitlerServer } from "../../src/index.js";
import { fakeFetch, json, type Reply } from "./fake.js";

const record = {
  id: "cu_1",
  projectId: "pj_1",
  environmentId: "en_1",
  externalId: "user_1",
  name: "Ada",
  attributes: [{ key: "region", value: "au" }],
  money: "CUSTOMER_MONEY_REAL",
  revision: 3,
  createdAt: 1_791_507_600,
  updatedAt: 1_791_507_700,
};

function setup(...replies: Reply[]) {
  const fake = fakeFetch(...replies);
  return { ...fake, customer: new EntitlerServer({ key: "k", fetch: fake.fetch }).customer("user_1") };
}

describe("the customer's record", () => {
  it("registers the customer with their details and visitor id", async () => {
    const { customer, sent } = setup(json({ customer: record, created: true }));
    const registered = await customer.register({
      name: "Ada",
      email: "ada@example.com",
      attributes: { region: "au", plan_hint: null, skipped: undefined as unknown as string },
      visitor: "vi_1",
    });
    expect(sent[0]).toMatchObject({
      method: "PUT",
      path: "/v1/customers/user_1",
      body: {
        name: "Ada",
        email: "ada@example.com",
        attributes: [{ key: "region", value: "au" }, { key: "plan_hint" }],
        visitorId: "vi_1",
      },
    });
    expect(registered).toEqual({
      customer: "user_1",
      customerId: "cu_1",
      name: "Ada",
      email: null,
      attributes: { region: "au" },
      trackId: null,
      money: "real",
      revision: 3,
      createdAt: new Date(1_791_507_600_000),
      updatedAt: new Date(1_791_507_700_000),
      created: true,
    });
  });

  it("registers with no details, reads and changes the record", async () => {
    const { customer, sent } = setup(json({ customer: record }));
    expect((await customer.register()).created).toBe(false);
    expect((await customer.details()).customerId).toBe("cu_1");
    await customer.update({ email: "ada@example.com" });
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      ["PUT", "/v1/customers/user_1", {}],
      ["GET", "/v1/customers/user_1", undefined],
      ["PATCH", "/v1/customers/user_1", { email: "ada@example.com" }],
    ]);
  });

  it("erases the customer, retrying a lost answer", async () => {
    const { customer, sent } = setup(new TypeError("fetch failed"), json({ erased: 1 }));
    await expect(customer.erase()).resolves.toBeUndefined();
    expect(sent.map((request) => request.method + request.path)).toEqual([
      "POST/v1/customers/user_1:erase",
      "POST/v1/customers/user_1:erase",
    ]);
  });
});

describe("customer tokens", () => {
  it("mints a token with the scopes and lifetime asked for", async () => {
    const { customer, sent } = setup(
      json({
        token: "ct_secret",
        tokenId: "tk_1",
        customerId: "cu_1",
        scopes: ["CUSTOMER_TOKEN_SCOPE_ENTITLEMENTS_READ", "CUSTOMER_TOKEN_SCOPE_USAGE_WRITE"],
        expiresAt: 1_791_511_200,
      }),
    );
    const issued = await customer.token({ scopes: ["entitlements:read", "usage:write"], ttlSeconds: 600 });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/tokens",
      body: {
        scopes: ["CUSTOMER_TOKEN_SCOPE_ENTITLEMENTS_READ", "CUSTOMER_TOKEN_SCOPE_USAGE_WRITE"],
        lifetimeSeconds: 600,
      },
    });
    expect(issued).toEqual({
      token: "ct_secret",
      id: "tk_1",
      customerId: "cu_1",
      scopes: ["entitlements:read", "usage:write"],
      expiresAt: new Date(1_791_511_200_000),
    });
  });

  it("asks for the default scope by sending none, for a customer not registered yet", async () => {
    const { customer, sent } = setup(json({ token: "ct_1", tokenId: "tk_1", scopes: [], expiresAt: 1 }));
    expect((await customer.token()).customerId).toBeNull();
    expect(sent[0]?.body).toEqual({});
  });

  it("refuses a lifetime the API refuses, before any request", async () => {
    const { customer, mock } = setup(json({}));
    await expect(customer.token({ ttlSeconds: 30 })).rejects.toThrow(RangeError);
    await expect(customer.token({ ttlSeconds: 3601 })).rejects.toThrow(RangeError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("the server's customers", () => {
  it("refuses me, which names an app's signed-in customer", () => {
    const { fetch } = fakeFetch(json({}));
    expect(() => new EntitlerServer({ key: "k", fetch }).customer("me")).toThrow(TypeError);
  });
});
