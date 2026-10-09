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
  UsageReplayedError,
} from "../../src/index.js";

const key = process.env.ENTITLER_TEST_KEY;
const publishable = process.env.ENTITLER_TEST_PUBLISHABLE_KEY;
if (!key) console.warn("Live API tests skipped: set ENTITLER_TEST_KEY to run them.");
console.info(
  "The test project has no sign-in provider and no Stripe connection, so unit tests alone cover the identity client and the pay, confirming and manage steps.",
);

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  collaboration: defineFeature("collaboration", "group", ["team_seats", "shared_folders"]),
  exportPdf: defineFeature("export_pdf", "boolean"),
  sso: defineFeature("sso", "boolean"),
};

const created: ServerCustomer[] = [];
let server: EntitlerServer;
let run = 0;

function newCustomer(): ServerCustomer {
  const customer = server.customer(`sdk-typescript-${newVisitorId().slice(0, 16)}`);
  created.push(customer);
  return customer;
}

function event(customer: ServerCustomer): string {
  run += 1;
  return `${customer.id}-${run}`;
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
    await Promise.all(created.map((customer) => customer.erase().catch(() => undefined)));
    server.close();
  });

  it("answers the key's scopes", async () => {
    const { scopes } = await server.scopes();
    expect(scopes).toEqual(expect.arrayContaining(["plans:read", "entitlements:read", "usage:write", "tracks:assign"]));
  });

  it("answers pricing for a visitor and the sample features", async () => {
    const pricing = await server.pricing({ visitor: newVisitorId() });
    expect(pricing.defaultPlan).toBe("free");
    expect(pricing.plans.map((plan) => plan.key)).toEqual(expect.arrayContaining(["free", "pro_basic", "pro"]));
    const pro = pricing.plans.find((plan) => plan.key === "pro");
    expect(pro?.periods.map((period) => [period.key, period.label])).toEqual([
      ["monthly", "Monthly"],
      ["yearly", "Yearly"],
    ]);
    const list = await server.features();
    expect(list.features.map((feature) => feature.key)).toEqual(
      expect.arrayContaining(["ai_credits", "collaboration", "export_pdf", "sso", "team_essentials"]),
    );
    expect(list.features.find((feature) => feature.key === "collaboration")?.includes).toEqual([
      "team_seats",
      "shared_folders",
    ]);
    expect(list.track.name).toBe("All customers");
  });

  it.skipIf(!publishable)("answers signed-out pricing through a publishable key", async () => {
    const client = new EntitlerClient({ key: publishable as string });
    const pricing = await client.pricing();
    expect(pricing.customer).toBeNull();
    expect(pricing.plans.map((plan) => plan.key)).toEqual(expect.arrayContaining(["free", "pro"]));
    client.close();
  });

  it("registers a customer, then changes their details", async () => {
    const customer = newCustomer();
    const first = await customer.register({ name: "Ada", email: "ada@example.com", metadata: { team: "a" } });
    expect(first).toMatchObject({ externalId: customer.id, created: true, replayed: false });
    const details = await customer.details();
    expect(details.customer).toMatchObject({ name: "Ada", email: "ada@example.com", metadata: { team: "a" } });
    const updated = await customer.update({ email: "ada@lovelace.example", metadata: { team: null, role: "admin" } });
    expect(updated).toMatchObject({ email: "ada@lovelace.example", metadata: { role: "admin" } });
    const second = await customer.register({ name: "Ada Lovelace" });
    expect(second.created).toBe(false);
  });

  it("checks features on the default plan, revalidates with a 304, and after a server-side change", async () => {
    const cache = countingCache();
    const customer = new EntitlerServer({ key: key as string, cache }).customer(newCustomer().id);
    await customer.register();
    const check = await customer.check(features.aiCredits);
    expect(check).toMatchObject({ type: "metered", entitled: true, value: 20, used: 0, stale: false });
    expect((await customer.check(features.exportPdf)).entitled).toBe(false);
    await customer.check(features.exportPdf, { revalidate: true });
    expect(cache.revalidated).toBe(1);
    await customer.entitlements();
    const entitlements = await customer.entitlements({ revalidate: true });
    expect(cache.revalidated).toBe(3);
    expect(entitlements.get(features.collaboration)).toMatchObject({ type: "group", entitled: false });
    expect(entitlements.has(features.collaboration)).toBe(false);
    await server.customer(customer.id).grant(features.exportPdf, { days: 1, idempotencyKey: event(customer) });
    expect((await customer.check(features.exportPdf, { revalidate: true })).entitled).toBe(true);
  });

  it("records, replays, refuses, observes, cancels and adjusts usage", async () => {
    const customer = newCustomer();
    await customer.register();
    const key1 = event(customer);
    const recorded = await customer.recordUsage(features.aiCredits, 5, { idempotencyKey: key1 });
    expect(recorded).toMatchObject({ outcome: "recorded", mode: "gate", used: 5, replayed: false });
    const replay = await customer.recordUsage(features.aiCredits, 5, { idempotencyKey: key1 });
    expect(replay).toMatchObject({ outcome: "duplicate", id: recorded.id, replayed: true });
    const refused = await customer.recordUsage(features.aiCredits, 100, { idempotencyKey: event(customer) });
    expect(refused).toMatchObject({ outcome: "refused", refusal: "over_allowance", used: 5 });
    const observed = await customer.recordUsage(features.aiCredits, 30, {
      mode: "observe",
      idempotencyKey: event(customer),
    });
    expect(observed).toMatchObject({ outcome: "recorded", mode: "observe", used: 35, overBy: 15 });
    const earlier = new Date(Date.now() - 60_000);
    const late = await customer.recordUsage(features.aiCredits, 1, {
      mode: "observe",
      occurredAt: earlier,
      idempotencyKey: event(customer),
    });
    expect(late.occurredAt?.getTime()).toBe(earlier.getTime());
    const usage = await customer.usage();
    const log = [];
    for await (const item of usage.log) log.push(item);
    expect(log.map((item) => item.amount).sort((a, b) => a - b)).toEqual([1, 5, 30]);
    const cancelled = await customer.cancelUsage(observed.id as string, { actor: "sdk-tests" });
    expect(cancelled).toMatchObject({ outcome: "cancelled", meterChange: -30 });
    const back = await customer.adjustMeter(features.aiCredits, { by: -2, idempotencyKey: event(customer) });
    expect(back).toMatchObject({ outcome: "adjusted", meterChange: -2, used: 4 });
    const set = await customer.adjustMeter(features.aiCredits, { to: 1, idempotencyKey: event(customer) });
    expect(set).toMatchObject({ outcome: "adjusted", meterChange: -3, used: 1 });
  });

  it("finishes a hold handle after use(n), releases another, and refuses a finished hold's key", async () => {
    const customer = newCustomer();
    await customer.register();
    const key1 = event(customer);
    const hold = await customer.startHold(features.aiCredits, 10, { idempotencyKey: key1, ttlSeconds: 60 });
    expect(hold).toMatchObject({ amount: 10, duplicate: false });
    hold.use(4);
    expect((await hold.finish()).outcome).toBe("settled");
    expect((await customer.check(features.aiCredits)).used).toBe(4);
    const unused = await customer.startHold(features.aiCredits, 3, { idempotencyKey: event(customer) });
    expect((await unused.release()).outcome).toBe("released");
    expect((await customer.check(features.aiCredits)).held).toBe(0);
    await expect(customer.startHold(features.aiCredits, 10, { idempotencyKey: key1 })).rejects.toBeInstanceOf(
      UsageReplayedError,
    );
  });

  it("settles, charges for reported work, and releases inside withHold", async () => {
    const customer = newCustomer();
    await customer.register();
    const reply = await customer.withHold(
      features.aiCredits,
      8,
      async ({ hold }) => {
        hold.use(6);
        return "summary";
      },
      { idempotencyKey: event(customer) },
    );
    expect(reply).toBe("summary");
    expect((await customer.check(features.aiCredits)).used).toBe(6);
    const failure = new Error("the work failed");
    await expect(
      customer.withHold(
        features.aiCredits,
        8,
        async ({ hold }) => {
          hold.use(3);
          throw failure;
        },
        { idempotencyKey: event(customer) },
      ),
    ).rejects.toBe(failure);
    expect((await customer.check(features.aiCredits)).used).toBe(9);
    await expect(
      customer.withHold(features.aiCredits, 8, () => Promise.reject(failure), { idempotencyKey: event(customer) }),
    ).rejects.toBe(failure);
    expect((await customer.check(features.aiCredits)).held).toBe(0);
    await expect(
      customer.withHold(features.aiCredits, 1000, async () => 1, { idempotencyKey: event(customer) }),
    ).rejects.toBeInstanceOf(UsageRefusedError);
  });

  it("records a batch with a replayed event, and the same batch resent answers replayed", async () => {
    const a = newCustomer();
    const b = newCustomer();
    await Promise.all([a.register(), b.register()]);
    const repeated = event(a);
    const events = [
      { customer: a.id, feature: features.aiCredits, amount: 2, idempotencyKey: repeated },
      { customer: b.id, feature: features.aiCredits, amount: 3, idempotencyKey: event(b) },
      { customer: a.id, feature: features.aiCredits, amount: 2, idempotencyKey: repeated },
    ];
    const batch = await server.recordUsageBatch(events);
    expect(batch.results.map((result) => result.outcome)).toEqual(["recorded", "recorded", "duplicate"]);
    expect(batch).toMatchObject({ recorded: 2, duplicates: 1, errors: 0 });
    const resent = await server.recordUsageBatch(events);
    expect(resent.results.every((result) => result.replayed)).toBe(true);
    expect((await a.check(features.aiCredits)).used).toBe(2);
  });

  it("answers the customer's plans and customer pricing", async () => {
    const customer = newCustomer();
    await customer.register();
    const plans = await customer.plans();
    expect(plans.held.map((held) => held.plan.key)).toEqual(["free"]);
    expect(plans.held[0]?.billedBy).toBeNull();
    const pro = plans.options.find((option) => option.plan.key === "pro");
    expect(pro?.action).toBe("buy");
    expect(pro?.periods.map((period) => period.key)).toEqual(["monthly", "yearly"]);
    const pricing = await customer.pricing({ visitor: newVisitorId() });
    expect(pricing.customer).toBe(customer.id);
  });

  it("serves in-app clients from customer tokens, by their scopes", async () => {
    const customer = newCustomer();
    await customer.register();
    const reader = await customer.token();
    expect(reader.scopes).toEqual(["entitlements:read"]);
    let minted = 0;
    const client = new EntitlerClient({
      token: async () => {
        minted += 1;
        return (await customer.token({ scopes: ["entitlements:read", "usage:write", "billing:self"], ttlSeconds: 600 }))
          .token;
      },
    });
    expect((await client.scopes()).scopes).toEqual(["entitlements:read", "usage:write", "billing:self"]);
    expect((await client.me.check(features.aiCredits)).customer).toBe(customer.id);
    expect((await client.me.entitlements()).has(features.aiCredits)).toBe(true);
    const usage = await client.me.recordUsage(features.aiCredits, 1, { idempotencyKey: event(customer) });
    expect(usage.outcome).toBe("recorded");
    try {
      const step = await client.me.subscribe("pro", { period: "monthly", returnUrl: "https://example.com/back" });
      expect(step.next).toBe("done");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "capability_required" });
    }
    expect(minted).toBe(1);
    client.close();
    const buyer = new EntitlerClient({ token: (await customer.token({ scopes: ["entitlements:read"] })).token });
    await expect(buyer.me.subscribe("pro", { period: "monthly" })).rejects.toMatchObject({
      status: 403,
      code: "scope_required",
    });
    buyer.close();
  });

  it("mints a snapshot and verifies it offline", async () => {
    const customer = newCustomer();
    await customer.register();
    const check = await customer.check(features.aiCredits);
    const keys = await server.snapshotKeys();
    const snapshot = await customer.snapshot({ ttlSeconds: 600 });
    const verified = await server.verifySnapshot(snapshot.token, {
      keys,
      customer: customer.id,
      environment: check.environment.id,
    });
    expect(verified.customer).toBe(customer.id);
    expect(verified.entitlements.has(features.aiCredits)).toBe(true);
  });

  it("moves a customer to the Beta track by name and back", async () => {
    const customer = newCustomer();
    await customer.register();
    const moved = await customer.setTrack("Beta");
    expect(moved.track.name).toBe("Beta");
    expect((await customer.check(features.aiCredits)).track.name).toBe("Beta");
    expect((await customer.setTrack(null)).track.name).toBe("All customers");
  });

  it("reads as of another instant, or answers capability_required", async () => {
    const asOf = new Date(Date.now() - 86_400_000);
    try {
      const check = await server.customer("test_1001").check(features.aiCredits, { asOf });
      expect(Date.now() - check.asOf.getTime()).toBeGreaterThan(86_000_000);
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "capability_required" });
    }
  });

  it("makes the customer's own billing choices", async () => {
    const customer = newCustomer();
    await customer.register({ name: "Billing test" });
    const pro = await customer.subscribe("pro", { period: "monthly", idempotencyKey: event(customer) });
    expect(pro).toMatchObject({ next: "done", plan: { key: "pro" } });
    expect((await customer.plans({ revalidate: true })).held[0]?.period?.key).toBe("monthly");
    expect((await customer.subscribe("sso_addon")).next).toBe("done");
    expect((await customer.check(features.sso)).entitled).toBe(true);
    expect((await customer.cancel({ addOn: "sso_addon" })).quantity).toBe(0);
    const cancelled = await customer.cancel();
    expect(cancelled.changed).toBe(true);
    expect((await customer.undoPendingChange()).changed).toBe(true);
    const free = newCustomer();
    await free.register();
    expect((await free.cancel()).changed).toBe(false);
    expect(await customer.syncBilling()).toEqual({ changed: false });
    await expect(customer.billingPortal({ returnUrl: "https://example.com/account" })).rejects.toMatchObject({
      status: 409,
      code: "stale",
    });
  });

  it("makes the company's decisions", async () => {
    const customer = newCustomer();
    await customer.register({ name: "Company test" });
    const period = (await customer.plans()).options.find((option) => option.plan.key === "pro_basic")?.periods[0]?.key;
    const basic = await customer.setPlan("pro_basic", { period, actor: "sdk-tests", idempotencyKey: event(customer) });
    expect(basic).toMatchObject({ plan: { key: "pro_basic" }, changed: true });
    expect((await customer.setPlan("pro_basic", { period, idempotencyKey: event(customer) })).changed).toBe(false);
    const until = new Date(Date.now() + 86_400_000);
    expect((await customer.setPlan("pro", { period: "monthly", until })).until?.getTime()).toBe(until.getTime());
    await customer.setPlan("pro_basic", { period });
    expect((await customer.setAddOn("support_standard", { quantity: 1 })).quantity).toBe(1);
    expect((await customer.setAddOn("support_standard", { quantity: 0 })).quantity).toBe(0);
    const granted = await customer.grant(features.sso, { days: 30, reason: "SDK test", actor: "sdk-tests" });
    expect(granted.grant).toMatchObject({ feature: "sso", actor: "sdk-tests" });
    expect((await customer.check(features.sso)).entitled).toBe(true);
    const revoked = await customer.revokeGrant(granted.grant.id);
    expect(revoked.grant.revokedAt).toBeInstanceOf(Date);
  });

  it("lists customers by search and a cursor, and erases one", async () => {
    const customer = newCustomer();
    await customer.register({ name: "Searchable" });
    const found = [];
    for await (const summary of server.customers.list({ q: customer.id })) found.push(summary.externalId);
    expect(found).toEqual([customer.id]);
    for await (const page of server.customers.list().pages()) {
      expect(page.used).toBeGreaterThan(0);
      if (page.next) {
        for await (const next of server.customers.list({ cursor: page.next }).pages()) {
          expect(Array.isArray(next.items)).toBe(true);
          break;
        }
      }
      break;
    }
    await customer.erase();
    await customer.erase();
    created.splice(created.indexOf(customer), 1);
    const after = [];
    for await (const summary of server.customers.list({ q: customer.id })) after.push(summary);
    expect(after).toEqual([]);
  });

  it("decodes API errors with their request id", async () => {
    const unregistered = server.customer(`sdk-typescript-${newVisitorId().slice(0, 16)}`);
    const notFound = (await unregistered
      .recordUsage(features.aiCredits, 1, { idempotencyKey: "never-registered" })
      .catch((e: unknown) => e)) as ApiError;
    expect(notFound).toBeInstanceOf(ApiError);
    expect(notFound).toMatchObject({ status: 404, code: "customer_not_found", idempotencyKey: "never-registered" });
    expect(notFound.requestId).toMatch(/\S+/);
    const unknown = (await server
      .customer("test_1001")
      .check("no_such_feature")
      .catch((e: unknown) => e)) as ApiError;
    expect(unknown).toMatchObject({ status: 404, code: "feature_not_found" });
    expect(unknown.requestId).toMatch(/\S+/);
  });
});
