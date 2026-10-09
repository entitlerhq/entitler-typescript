import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiError,
  type CacheEntry,
  type CacheStore,
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  newVisitorId,
  type ServerCustomer,
  UsageRefusedError,
} from "../../src/index.js";

const key = process.env.ENTITLER_TEST_KEY;
if (!key) console.warn("Live API tests skipped: set ENTITLER_TEST_KEY to run them.");
console.info("The test project has no sign-in provider, so unit tests alone cover the identity client.");

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  collaboration: defineFeature("collaboration", "group", ["team_seats", "shared_folders"]),
  exportPdf: defineFeature("export_pdf", "boolean"),
  sso: defineFeature("sso", "boolean"),
};

const created: ServerCustomer[] = [];
let server: EntitlerServer;

function newCustomer(): ServerCustomer {
  const customer = server.customer(`sdk-typescript-${newVisitorId().slice(0, 16)}`);
  created.push(customer);
  return customer;
}

function countingCache(): CacheStore & { revalidated: number } {
  const entries = new Map<string, CacheEntry>();
  const store = {
    revalidated: 0,
    get: (k: string) => entries.get(k),
    set: (k: string, entry: CacheEntry) => {
      if (entries.has(k)) store.revalidated += 1;
      entries.set(k, entry);
    },
  };
  return store;
}

describe.skipIf(!key)("the live API", { timeout: 60_000 }, () => {
  beforeAll(() => {
    server = new EntitlerServer({ key: key as string });
  });

  afterAll(async () => {
    await Promise.all(created.map((customer) => customer.delete({ erase: true }).catch(() => undefined)));
  });

  it("answers the key's scopes", async () => {
    const { scopes } = await server.scopes();
    expect(scopes).toEqual(expect.arrayContaining(["plans:read", "entitlements:read", "usage:write", "tracks:assign"]));
  });

  it("answers pricing for a visitor and the sample features", async () => {
    const pricing = await server.pricing({ visitor: newVisitorId() });
    expect(pricing.defaultPlan).toBe("free");
    expect(pricing.plans.map((plan) => plan.key)).toEqual(expect.arrayContaining(["free", "pro_basic", "pro"]));
    const list = await server.features();
    expect(list.features.map((feature) => feature.key)).toEqual(
      expect.arrayContaining(["ai_credits", "collaboration", "export_pdf", "sso", "team_essentials"]),
    );
    expect(list.features.find((feature) => feature.key === "collaboration")?.includes).toEqual([
      "team_seats",
      "shared_folders",
    ]);
    expect(list.track.name).toBe("All customers");
    expect(list.release === null || typeof list.release === "number").toBe(true);
  });

  it("registers a customer, then changes their details", async () => {
    const customer = newCustomer();
    const first = await customer.register({ name: "Ada", email: "ada@example.com", metadata: { team: "a" } });
    expect(first).toMatchObject({ externalId: customer.id, created: true });
    expect(first.createdAt).toBeInstanceOf(Date);
    const details = await customer.details();
    expect(details.customer).toMatchObject({ name: "Ada", email: "ada@example.com", metadata: { team: "a" } });
    const updated = await customer.update({ email: "ada@lovelace.example", metadata: { team: null, role: "admin" } });
    expect(updated).toMatchObject({ email: "ada@lovelace.example", metadata: { role: "admin" } });
    const second = await customer.register({ name: "Ada Lovelace" });
    expect(second.created).toBe(false);
    expect((await customer.details()).customer).toMatchObject({ name: "Ada Lovelace", email: "ada@lovelace.example" });
  });

  it("checks features on the default plan, groups included, and revalidates with a 304", async () => {
    const cache = countingCache();
    const customer = new EntitlerServer({ key: key as string, cache }).customer(newCustomer().id);
    const check = await customer.check(features.aiCredits);
    expect(check).toMatchObject({ type: "metered", entitled: true, value: 20, used: 0, stale: false });
    const pdf = await customer.check(features.exportPdf);
    expect(pdf).toMatchObject({ entitled: false, value: 0 });
    await customer.check(features.exportPdf);
    expect(cache.revalidated).toBe(1);
    expect(await customer.isEntitled(features.exportPdf, { default: true })).toBe(false);
    await customer.entitlements();
    const entitlements = await customer.entitlements();
    expect(cache.revalidated).toBe(3);
    expect(entitlements.get(features.collaboration)).toMatchObject({ type: "group", entitled: false });
    expect(entitlements.has(features.collaboration)).toBe(false);
    expect(entitlements.has(features.aiCredits)).toBe(true);
  });

  it("records, replays, refuses and observes usage", async () => {
    const customer = newCustomer();
    await customer.register();
    const recorded = await customer.recordUsage(features.aiCredits, 5, { idempotencyKey: `${customer.id}-1` });
    expect(recorded).toMatchObject({
      outcome: "recorded",
      mode: "gate",
      amount: 5,
      meterChange: 5,
      used: 5,
      overBy: 0,
    });
    const replay = await customer.recordUsage(features.aiCredits, 5, { idempotencyKey: `${customer.id}-1` });
    expect(replay).toMatchObject({ outcome: "duplicate", id: recorded.id, meterChange: 0 });
    const refused = await customer.recordUsage(features.aiCredits, 100);
    expect(refused).toMatchObject({ outcome: "refused", refusal: "over_allowance", used: 5 });
    const observed = await customer.recordUsage(features.aiCredits, 30, { mode: "observe" });
    expect(observed).toMatchObject({ outcome: "recorded", mode: "observe", used: 35, overBy: 15 });
    const earlier = new Date(Date.now() - 60_000);
    const late = await customer.recordUsage(features.aiCredits, 1, { mode: "observe", occurredAt: earlier });
    expect(late.occurredAt?.getTime()).toBe(Math.floor(earlier.getTime()));
    const usage = await customer.usage();
    expect(usage.features.find((meter) => meter.feature === "ai_credits")?.used).toBe(36);
    const log = [];
    for await (const event of usage.log) log.push(event);
    expect(log.map((event) => event.amount).sort((a, b) => a - b)).toEqual([1, 5, 30]);
    const cancelled = await customer.vendor.cancelUsage(observed.id as string);
    expect(cancelled).toMatchObject({ outcome: "cancelled", meterChange: -30 });
    const set = await customer.vendor.setMeter(features.aiCredits, 2);
    expect(set).toMatchObject({ outcome: "adjusted", meterChange: -4, used: 2 });
  });

  it("holds, settles, releases and reads holds back", async () => {
    const customer = newCustomer();
    await customer.register();
    const hold = await customer.holdUsage(features.aiCredits, 10, { ttlSeconds: 60 });
    expect(hold).toMatchObject({ outcome: "held", held: 10, remaining: 10 });
    expect(hold.expiresAt).toBeInstanceOf(Date);
    const read = await customer.hold(hold.holdId as string);
    expect(read).toMatchObject({ id: hold.holdId, state: "open", amount: 10 });
    const settled = await customer.settleUsage(hold.holdId as string, 4);
    expect(settled).toMatchObject({ outcome: "settled", used: 4, held: 0 });
    expect((await customer.settleUsage(hold.holdId as string, 4)).outcome).toBe("duplicate");
    const second = await customer.holdUsage(features.aiCredits, 3);
    expect((await customer.releaseUsage(second.holdId as string)).outcome).toBe("released");
    expect((await customer.releaseUsage(second.holdId as string)).outcome).toBe("released");
    expect((await customer.hold(second.holdId as string)).state).toBe("released");
    await expect(customer.settleUsage(second.holdId as string, 1)).rejects.toMatchObject({ code: "hold_released" });
  });

  it("runs work inside withHold", async () => {
    const customer = newCustomer();
    await customer.register();
    const reply = await customer.withHold(features.aiCredits, 8, async ({ hold }) => {
      hold.use(6);
      return "summary";
    });
    expect(reply).toBe("summary");
    expect((await customer.check(features.aiCredits)).used).toBe(6);
    await expect(
      customer.withHold(features.aiCredits, 8, async () => {
        throw new Error("the work failed");
      }),
    ).rejects.toThrow("the work failed");
    expect((await customer.check(features.aiCredits)).held).toBe(0);
    await expect(customer.withHold(features.aiCredits, 1000, async () => 1)).rejects.toBeInstanceOf(UsageRefusedError);
  });

  it("records a batch with a replayed event", async () => {
    const a = newCustomer();
    const b = newCustomer();
    await Promise.all([a.register(), b.register()]);
    const batch = await server.recordUsageBatch([
      { customer: a.id, feature: features.aiCredits, amount: 2, idempotencyKey: `${a.id}-batch` },
      { customer: b.id, feature: features.aiCredits, amount: 3 },
      { customer: a.id, feature: features.aiCredits, amount: 2, idempotencyKey: `${a.id}-batch` },
    ]);
    expect(batch.results.map((result) => result.outcome)).toEqual(["recorded", "recorded", "duplicate"]);
    expect(batch).toMatchObject({ recorded: 2, duplicates: 1, errors: 0 });
    expect((await a.check(features.aiCredits)).used).toBe(2);
  });

  it("answers the customer's plans and customer pricing", async () => {
    const customer = newCustomer();
    const space = await customer.plans();
    expect(space.held.map((held) => held.plan.key)).toEqual(["free"]);
    expect(space.options.map((option) => option.plan.key)).toEqual(expect.arrayContaining(["pro"]));
    const pricing = await customer.pricing({ visitor: newVisitorId() });
    expect(pricing.customer).toBe(customer.id);
    expect(pricing.stale).toBe(false);
  });

  it("serves an in-app client from a customer token", async () => {
    const customer = newCustomer();
    await customer.register();
    let minted = 0;
    const client = new EntitlerClient({
      token: async () => {
        minted += 1;
        return (await customer.token({ scopes: ["entitlements:read", "usage:read", "usage:write"], ttlSeconds: 600 }))
          .token;
      },
    });
    expect((await client.me.check(features.aiCredits)).customer).toBe(customer.id);
    expect(client.me.id).toBe(customer.id);
    expect((await client.me.entitlements()).has(features.aiCredits)).toBe(true);
    expect((await client.me.recordUsage(features.aiCredits, 1)).outcome).toBe("recorded");
    const error = (await (client as unknown as EntitlerClient<"identity">)
      .register()
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(TypeError);
    const refused = (await client.me.plans().then(
      () => undefined,
      (e: unknown) => e,
    )) as ApiError | undefined;
    if (refused) expect(["credential_not_allowed", "scope_required"]).toContain(refused.code);
    const limited = new EntitlerClient({
      token: (await customer.token({ scopes: ["entitlements:read", "usage:write"] })).token,
    });
    await expect(limited.me.usage()).rejects.toMatchObject({ status: 403, code: "scope_required" });
    expect(minted).toBe(1);
    expect((await client.scopes()).scopes).toEqual(["entitlements:read", "usage:read", "usage:write"]);
  });

  it("mints a snapshot and verifies it offline", async () => {
    const customer = newCustomer();
    const check = await customer.check(features.aiCredits);
    const keys = await server.snapshotKeys();
    const snapshot = await customer.snapshot({ ttlSeconds: 600 });
    const verified = await server.verifySnapshot(snapshot.token, {
      keys,
      customer: customer.id,
      environment: check.environment.id,
    });
    expect(verified.customer).toBe(customer.id);
    expect(verified.expiresAt).toEqual(snapshot.expiresAt);
    expect(verified.entitlements.has(features.aiCredits)).toBe(true);
    expect(verified.entitlements.get(features.collaboration)?.entitled).toBe(false);
  });

  it("moves a customer to the Beta track and back", async () => {
    const beta = (await server.customer("test_1013").details()).customer.track;
    expect(beta.name).toBe("Beta");
    const customer = newCustomer();
    await customer.register();
    const moved = await customer.setTrack(beta.id);
    expect(moved.track).toEqual(beta);
    expect((await customer.check(features.aiCredits)).track).toEqual(beta);
    const back = await customer.setTrack(null);
    expect(back.track.name).toBe("All customers");
  });

  it("reads as of another instant, or answers limit_reached", async () => {
    const past = new EntitlerServer({ key: key as string, asOf: new Date(Date.now() - 86_400_000) });
    try {
      const check = await past.customer("test_1001").check(features.aiCredits);
      expect(Date.now() - check.asOf.getTime()).toBeGreaterThan(86_000_000);
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "limit_reached" });
    }
  });

  it("changes plans self-serve and as the vendor", async () => {
    const customer = newCustomer();
    await customer.register({ name: "Billing test" });
    await expect(
      customer.checkout("pro", { successUrl: "https://example.com/ok", cancelUrl: "https://example.com/no" }),
    ).rejects.toMatchObject({ status: 409, code: "stale" });
    await expect(customer.billingPortal({ returnUrl: "https://example.com/account" })).rejects.toMatchObject({
      status: 409,
      code: "stale",
    });
    const pro = await customer.subscribe("pro", { period: "Monthly" });
    expect(pro.subscription).toMatchObject({ plan: { key: "pro" }, period: "Monthly" });
    expect(pro.selfServe).toBe(true);
    expect((await customer.check(features.exportPdf)).entitled).toBe(true);
    const withAddOn = await customer.addAddOn("sso_addon");
    expect(withAddOn.subscription?.addOns.map((addOn) => addOn.plan.key)).toContain("sso_addon");
    expect((await customer.check(features.sso)).entitled).toBe(true);
    const without = await customer.removeAddOn("sso_addon");
    expect(without.subscription?.addOns.map((addOn) => addOn.plan.key)).not.toContain("sso_addon");
    expect((await customer.check(features.sso)).entitled).toBe(false);
    const free = await customer.subscribe("free");
    expect(free.subscription?.pending).toMatchObject({ type: "move", plan: { key: "free" } });
    expect((await customer.undoPendingChange()).subscription?.pending).toBeNull();
    const period = (await server.pricing()).plans.find((plan) => plan.key === "pro_basic")?.periods[0]?.label;
    const vendorMove = await customer.vendor.subscribe("pro_basic", { period, when: "now" });
    expect(vendorMove.subscription?.plan.key).toBe("pro_basic");
    const granted = await customer.vendor.grant(features.sso, { days: 30, reason: "SDK test" });
    const grant = granted.grants.find((each) => each.feature === "sso" && each.revokedAt === null);
    expect(grant?.until).toBeInstanceOf(Date);
    expect((await customer.check(features.sso)).entitled).toBe(true);
    const revoked = await customer.vendor.revokeGrant(grant?.id as string);
    expect(revoked.grants.some((each) => each.id === grant?.id && each.revokedAt === null)).toBe(false);
    expect((await customer.check(features.sso)).entitled).toBe(false);
    const meter = await customer.vendor.setMeter(features.aiCredits, 7);
    expect(meter).toMatchObject({ outcome: "adjusted", used: 7 });
  });

  it("lists customers by search and deletes with erase", async () => {
    const customer = newCustomer();
    await customer.register({ name: "Searchable" });
    const found = [];
    for await (const summary of server.customers.list({ q: customer.id })) found.push(summary.externalId);
    expect(found).toEqual([customer.id]);
    await customer.delete({ erase: true });
    created.splice(created.indexOf(customer), 1);
    const after = [];
    for await (const summary of server.customers.list({ q: customer.id })) after.push(summary);
    expect(after).toEqual([]);
  });

  it("decodes API errors with their request id", async () => {
    const unregistered = server.customer(`sdk-typescript-${newVisitorId().slice(0, 16)}`);
    const notFound = (await unregistered.recordUsage(features.aiCredits, 1).catch((e: unknown) => e)) as ApiError;
    expect(notFound).toBeInstanceOf(ApiError);
    expect(notFound).toMatchObject({ status: 404, code: "customer_not_found" });
    expect(notFound.requestId).toMatch(/\S+/);
    expect(notFound.idempotencyKey).toMatch(/\S+/);
    const unknown = (await server
      .customer("test_1001")
      .check("no_such_feature")
      .catch((e: unknown) => e)) as ApiError;
    expect(unknown).toMatchObject({ status: 404, code: "feature_not_found" });
    expect(unknown.requestId).toMatch(/\S+/);
  });
});
