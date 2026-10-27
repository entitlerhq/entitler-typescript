import { describe, expect, it } from "vitest";
import { defineFeature, EntitlerServer } from "../../src/index.js";
import { apiError, fakeFetch, json, type Reply, usageAnswer } from "./fake.js";

const grant = {
  id: "gr_1",
  featureKey: "ai_credits",
  value: { limit: { count: 5000 } },
  from: 1_791_507_600,
  until: 1_794_099_600,
  reason: "Support ticket 4127",
  grantedBy: { type: "ACTOR_TYPE_KEY", id: "key_1" },
};

function setup(...replies: Reply[]) {
  const fake = fakeFetch(...replies);
  return { ...fake, customer: new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false }).customer("user_1") };
}

describe("grants", () => {
  it("grants a value for some days, against the revision the change was decided on", async () => {
    const { customer, sent } = setup(json({ grant, revision: 8 }));
    const result = await customer.grant(defineFeature("ai_credits", "metered"), {
      value: 5000,
      days: 30,
      reason: "Support ticket 4127",
      expectedRevision: 7,
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/grants",
      body: {
        featureKey: "ai_credits",
        value: { limit: { count: 5000 } },
        days: 30,
        reason: "Support ticket 4127",
        expectedRevision: { value: 7 },
      },
    });
    expect(result).toEqual({
      revision: 8,
      grant: {
        id: "gr_1",
        feature: "ai_credits",
        value: 5000,
        from: new Date(1_791_507_600_000),
        until: new Date(1_794_099_600_000),
        reason: "Support ticket 4127",
        revokedAt: null,
        revokeReason: null,
        grantedBy: { type: "key", id: "key_1" },
        revokedBy: null,
      },
    });
  });

  it("grants a switch, or an unlimited or money value, until revoked", async () => {
    const { customer, sent } = setup(json({ grant: { ...grant, value: { on: {} }, until: undefined }, revision: 8 }));
    const result = await customer.grant("export_pdf", { value: true });
    await customer.grant("ai_credits", { value: "unlimited" });
    await customer.grant("spend", { value: 2500, currency: "aud" });
    expect(sent.map((request) => request.body)).toEqual([
      { featureKey: "export_pdf", value: { on: {} } },
      { featureKey: "ai_credits", value: { limit: { unlimited: {} } } },
      { featureKey: "spend", value: { limit: { count: 2500 } }, currency: "aud" },
    ]);
    expect(result.grant).toMatchObject({ value: true, until: null });
  });

  it("refuses a value or days the API would refuse, sending nothing", async () => {
    const { customer, sent } = setup(json({ grant, revision: 8 }));
    await expect(customer.grant("ai_credits", { value: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(customer.grant("ai_credits", { value: false as unknown as true })).rejects.toBeInstanceOf(TypeError);
    await expect(customer.grant("ai_credits", { value: 1, days: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(customer.grant("ai_credits", { value: 1, days: 3651 })).rejects.toBeInstanceOf(RangeError);
    expect(sent).toHaveLength(0);
  });

  it("revokes a grant, retrying a revocation that failed on the way", async () => {
    const revoked = {
      ...grant,
      revokedAt: 1_791_600_000,
      revokeReason: "Refunded",
      revokedBy: { type: "ACTOR_TYPE_USER", id: "us_9" },
    };
    const { customer, sent } = setup(
      apiError(503, "Unavailable"),
      json({ grant: revoked, revision: 9, changed: true }),
    );
    const result = await customer.revokeGrant("gr_1", { reason: "Refunded", expectedRevision: 8 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/grants/gr_1:revoke",
      body: { reason: "Refunded", expectedRevision: { value: 8 } },
    });
    expect(result).toMatchObject({
      revision: 9,
      changed: true,
      grant: {
        revokedAt: new Date(1_791_600_000_000),
        revokeReason: "Refunded",
        revokedBy: { type: "user", id: "us_9" },
      },
    });
  });
});

describe("setTrack", () => {
  const assignment = {
    customerId: "cu_1",
    externalId: "user_1",
    trackId: "tr_beta",
    source: "ASSIGNMENT_SOURCE_SERVER",
    money: "CUSTOMER_MONEY_TEST",
    revision: 4,
  };

  it("moves the customer to a track, and back to the default track with null", async () => {
    const { customer, sent } = setup(
      json({ assignment, changed: true, endedTestHoldings: 0 }),
      json({
        assignment: { ...assignment, trackId: undefined, previousTrackId: "tr_beta" },
        changed: true,
        endedTestHoldings: 2,
      }),
    );
    expect(await customer.setTrack("tr_beta")).toEqual({
      track: "tr_beta",
      previousTrack: null,
      source: "server",
      money: "test",
      revision: 4,
      changed: true,
      endedTestHoldings: 0,
    });
    expect(await customer.setTrack(null)).toMatchObject({
      track: null,
      previousTrack: "tr_beta",
      endedTestHoldings: 2,
    });
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      ["PUT", "/v1/customers/user_1/track", { trackId: "tr_beta" }],
      ["PUT", "/v1/customers/user_1/track", {}],
    ]);
  });
});

describe("meter adjustments and cancelled usage", () => {
  it("sets a meter, or moves it by an amount, and retries only a keyed adjustment", async () => {
    const { customer, sent } = setup(
      json(usageAnswer({ outcome: "adjusted" })),
      apiError(503, "Unavailable"),
      json(usageAnswer({ outcome: "adjusted" })),
    );
    const result = await customer.adjustMeter("ai_credits", { setTo: 0, reason: "New contract" });
    expect(result.outcome).toBe("adjusted");
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/meters/ai_credits:adjust",
      body: { setTo: 0, reason: "New contract" },
    });
    await customer.adjustMeter("spend", { changeBy: -250, idempotencyKey: "refund-9", currency: "aud" });
    expect(sent.slice(1).map((request) => request.body)).toEqual([
      { changeBy: -250, idempotencyKey: "refund-9", currency: "aud" },
      { changeBy: -250, idempotencyKey: "refund-9", currency: "aud" },
    ]);

    const unkeyed = setup(apiError(503, "Unavailable"));
    await expect(unkeyed.customer.adjustMeter("ai_credits", { changeBy: 5 })).rejects.toMatchObject({ status: 503 });
    expect(unkeyed.sent).toHaveLength(1);
  });

  it("takes exactly one of setTo and changeBy", async () => {
    const { customer, sent } = setup(json(usageAnswer({ outcome: "adjusted" })));
    const both = { setTo: 1, changeBy: 1 } as unknown as { setTo: number };
    await expect(customer.adjustMeter("ai_credits", both)).rejects.toThrow("Pass exactly one of setTo and changeBy.");
    await expect(customer.adjustMeter("ai_credits", {} as { setTo: number })).rejects.toBeInstanceOf(TypeError);
    await expect(customer.adjustMeter("ai_credits", { setTo: -1 })).rejects.toBeInstanceOf(RangeError);
    expect(sent).toHaveLength(0);
  });

  it("cancels a usage report, retrying a cancellation that failed on the way", async () => {
    const { customer, sent } = setup(apiError(503, "Unavailable"), json(usageAnswer({ outcome: "cancelled" })));
    expect((await customer.cancelUsage("us_1", { reason: "Duplicate job" })).outcome).toBe("cancelled");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/usage/us_1:cancel",
      body: { reason: "Duplicate job" },
    });
  });
});
