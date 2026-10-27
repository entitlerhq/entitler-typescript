import { describe, expect, it } from "vitest";
import { defineFeature, EntitlerServer } from "../../src/index.js";
import { answerContext, apiError, checkAnswer, fakeFetch, json, wireEntitlement } from "./fake.js";

function customer(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return { ...fake, customer: new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false }).customer("user_1") };
}

describe("check", () => {
  it("decodes an on/off feature and where it comes from", async () => {
    const { customer: ada } = customer(json(checkAnswer()));
    const check = await ada.check("export_pdf");
    expect(check).toEqual({
      customer: "user_1",
      customerId: "cu_1",
      asOf: new Date(1_791_507_600_000),
      nextChangeAt: null,
      served: { track: null, source: { type: "release", id: "rl_1", number: 2 } },
      key: "export_pdf",
      type: "switch",
      entitled: true,
      value: true,
      sources: [
        {
          type: "plan",
          planId: "pl_1",
          plan: "pro",
          name: "Pro",
          product: "pr_1",
          version: 1,
          byDefault: false,
          value: true,
          through: null,
        },
      ],
      upgrades: [],
      meter: null,
      stale: false,
    });
  });

  it("answers 0 for a feature that is off", async () => {
    const { customer: ada } = customer(json(checkAnswer({ entitled: false, value: { switch: false }, sources: [] })));
    expect((await ada.check("export_pdf")).value).toBe(0);
  });

  it("decodes a metered feature with its meter, unlimited included", async () => {
    const { customer: ada } = customer(
      json(
        checkAnswer({
          featureKey: "ai_credits",
          kind: "ENTITLED_FEATURE_KIND_METERED",
          value: { metered: { unlimited: {} } },
          meter: { used: 3, held: 1, banked: 2, remaining: { unlimited: {} } },
          sources: [],
        }),
      ),
    );
    const check = await ada.check(defineFeature("ai_credits", "metered"));
    expect(check.value).toBe("unlimited");
    expect(check.meter).toEqual({ used: 3, held: 1, banked: 2, remaining: "unlimited", resetsAt: null });
  });

  it("reads a metered feature's missing meter as empty", async () => {
    const { customer: ada } = customer(
      json(checkAnswer({ kind: "ENTITLED_FEATURE_KIND_METERED", value: { metered: {} }, sources: [] })),
    );
    expect((await ada.check(defineFeature("f", "metered"))).meter).toEqual({
      used: 0,
      held: 0,
      banked: 0,
      remaining: 0,
      resetsAt: null,
    });
  });

  it("decodes a setting, and reads a missing count as 0", async () => {
    const { customer: ada } = customer(
      json(checkAnswer({ kind: "ENTITLED_FEATURE_KIND_CONFIGURATION", value: { configuration: {} }, sources: [] })),
    );
    const check = await ada.check("seats");
    expect(check.type).toBe("configuration");
    expect(check.value).toBe(0);
  });

  it("decodes a group from its decision, and every source kind", async () => {
    const { customer: ada } = customer(
      json(
        checkAnswer({
          kind: "ENTITLED_FEATURE_KIND_GROUP",
          value: { group: { members: [] } },
          sources: [
            { group: { featureKeys: ["a", "b"] } },
            {
              defaultPlan: {
                planId: "pl_0",
                planKey: "free",
                planName: "Free",
                productId: "pr_1",
                versionNumber: 3,
                throughFeatureKey: "suite",
              },
            },
            {
              addOn: {
                planId: "pl_2",
                planKey: "seats",
                planName: "Seats",
                versionNumber: 1,
                quantity: 4,
                value: { configuration: { count: 4 } },
              },
            },
            { grant: { grantId: "gr_1", until: 1_793_491_200, value: { switch: true } } },
          ],
          upgrades: [
            {
              kind: "UPGRADE_KIND_PLAN",
              planId: "pl_3",
              planKey: "team",
              planName: "Team",
              productId: "pr_1",
              move: "UPGRADE_MOVE_UPGRADE",
              action: "UPGRADE_ACTION_BUY",
            },
          ],
        }),
      ),
    );
    const check = await ada.check("suite");
    expect(check.value).toBe(true);
    expect(check.sources).toEqual([
      { type: "group", features: ["a", "b"] },
      {
        type: "plan",
        planId: "pl_0",
        plan: "free",
        name: "Free",
        product: "pr_1",
        version: 3,
        byDefault: true,
        value: null,
        through: "suite",
      },
      { type: "addon", planId: "pl_2", plan: "seats", name: "Seats", version: 1, quantity: 4, value: 4, through: null },
      { type: "grant", grant: "gr_1", until: new Date("2026-11-01T00:00:00Z"), value: true, through: null },
    ]);
    expect(check.upgrades).toEqual([
      { kind: "plan", planId: "pl_3", plan: "team", name: "Team", product: "pr_1", move: "upgrade", action: "buy" },
    ]);
  });

  it.each([
    [
      { track: { id: "tk_1", name: "Beta" }, changeId: "ch_1" },
      { track: { id: "tk_1", name: "Beta" }, source: { type: "change", id: "ch_1" } },
    ],
    [
      { track: { id: "tk_1", name: "Beta" }, nothing: {} },
      { track: { id: "tk_1", name: "Beta" }, source: { type: "nothing" } },
    ],
  ])("decodes the served catalogue %j", async (served, expected) => {
    const { customer: ada } = customer(json({ ...checkAnswer(), served }));
    expect((await ada.check("f")).served).toEqual(expected);
  });

  it("reads a customer not registered yet, a plan without a product and a missing decision", async () => {
    const { customer: ada } = customer(
      json({
        ...checkAnswer({
          entitled: undefined,
          sources: [{ defaultPlan: { planId: "pl_0", planKey: "free", planName: "Free", versionNumber: 1 } }],
        }),
        customer: { externalId: "user_1" },
      }),
    );
    const check = await ada.check("f");
    expect(check.customerId).toBeNull();
    expect(check.entitled).toBe(false);
    expect(check.sources[0]).toMatchObject({ type: "plan", product: null, byDefault: true });
  });

  it("skips a source kind this SDK doesn't know", async () => {
    const { customer: ada } = customer(
      json(checkAnswer({ sources: [{ brandNew: {} }, { group: { featureKeys: [] } }] })),
    );
    expect((await ada.check("f")).sources).toEqual([{ type: "group", features: [] }]);
  });

  it("refuses an answer of another type than the feature constant declares", async () => {
    const { customer: ada } = customer(json(checkAnswer()));
    await expect(ada.check(defineFeature("export_pdf", "metered"))).rejects.toThrow(
      "export_pdf is declared metered, but Entitler answers it as switch.",
    );
  });

  it("names the field an unreadable answer lacks", async () => {
    const { customer: ada } = customer(json(checkAnswer({ featureKey: 7 })));
    const error = await ada.check("f").catch((e: unknown) => e);
    expect((error as Error & { cause: Error }).cause.message).toBe(
      "The answer lacks a required field, or holds one of another type at entitlement.featureKey.",
    );
  });
});

describe("isEntitled", () => {
  it("answers Entitler's decision", async () => {
    const { customer: ada } = customer(json(checkAnswer({ entitled: false })));
    expect(await ada.isEntitled("export_pdf", { default: true })).toBe(false);
  });

  it("answers the default when Entitler cannot be asked", async () => {
    const { customer: ada } = customer(apiError(404, "NotFound", "CUSTOMER_NOT_FOUND"));
    expect(await ada.isEntitled("export_pdf", { default: true })).toBe(true);
  });

  it("rejects with the caller's abort instead of answering the default", async () => {
    const { customer: ada } = customer(json(checkAnswer()));
    const signal = AbortSignal.abort(new Error("stop"));
    await expect(ada.isEntitled("f", { default: true, signal })).rejects.toBe(signal.reason);
  });

  it("rejects once the client is closed", async () => {
    const { fetch } = fakeFetch(json(checkAnswer()));
    const entitler = new EntitlerServer({ key: "k", fetch });
    entitler.close();
    await expect(entitler.customer("u").isEntitled("f", { default: true })).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("refuses a missing default and a bad asOf before any request", async () => {
    const { customer: ada, mock } = customer(json(checkAnswer()));
    await expect(ada.isEntitled("f", {} as { default: boolean })).rejects.toThrow("Pass default as true or false.");
    await expect(ada.isEntitled("f", { default: false, asOf: new Date(Number.NaN) })).rejects.toThrow(
      "Pass asOf as a valid date.",
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("entitlements", () => {
  it("lists every entitlement and answers has and get", async () => {
    const { customer: ada, sent } = customer(
      json({
        ...answerContext,
        nextChangeAt: 1_793_491_200,
        entitlements: [wireEntitlement(), wireEntitlement({ featureKey: "sso", entitled: false })],
      }),
    );
    const entitlements = await ada.entitlements();
    expect(sent[0]?.path).toBe("/v1/customers/user_1/entitlements");
    expect(entitlements.nextChangeAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(entitlements.has("export_pdf")).toBe(true);
    expect(entitlements.has("sso")).toBe(false);
    expect(entitlements.has("missing")).toBe(false);
    expect(entitlements.get(defineFeature("sso", "switch"))?.entitled).toBe(false);
    expect([...entitlements].map((entitlement) => entitlement.key)).toEqual(["export_pdf", "sso"]);
  });
});
