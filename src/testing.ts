import type { ServerCustomer } from "./customer.js";
import { EntitlerServer } from "./server.js";
import type { FeatureType, Limit, Value } from "./types.js";

/** A JSON body, as the API sends it. */
export type Body = Record<string, unknown>;

/** A metered feature in {@link fakeCustomer}: its allowance and how much is used. */
export interface FakeMeter {
  /** The allowance. */
  readonly value: Value;
  /** How much is used. Defaults to 0. */
  readonly used?: number;
}

/** A feature's value in {@link fakeCustomer}: on, an amount, unlimited, or a meter. */
export type FakeValue = Value | FakeMeter;

/** Options for {@link fakeCustomer}. */
export interface FakeCustomerOptions {
  /** The customer's external id. Defaults to `customer_1`. */
  id?: string;
  /** The body `plans()` answers, built with {@link answers}' `plans`. */
  plans?: Body;
  /** The body `pricing()` answers, built with {@link answers}' `pricing`. */
  pricing?: Body;
}

/** One write a fake customer received. */
export interface FakeWrite {
  /** The method's name, such as `recordUsage`. */
  readonly method: string;
  /** The arguments it was called with. */
  readonly args: readonly unknown[];
}

/** The name of a method of {@link ServerCustomer}, such as `check` or `recordUsage`. */
export type CustomerMethod = {
  [K in keyof ServerCustomer]: ServerCustomer[K] extends (...args: never[]) => unknown ? K : never;
}[keyof ServerCustomer];

/** A replacement answer for one method: it takes that method's arguments and answers its result, or a promise of it. */
export type FakeAnswer<M extends CustomerMethod> = ServerCustomer[M] extends (...args: infer A) => infer R
  ? (...args: A) => R | Awaited<R>
  : never;

/** A {@link ServerCustomer} that makes no request, for an app's own tests. */
export interface FakeCustomer extends ServerCustomer {
  /** Every write received, in order. */
  readonly writes: readonly FakeWrite[];
  /** Replaces one method's answer: `fn` receives the call's arguments and answers in its place. */
  answer<M extends CustomerMethod>(method: M, fn: NoInfer<FakeAnswer<M>>): void;
}

const WRITES = new Set([
  "register",
  "update",
  "erase",
  "token",
  "setTrack",
  "setPlan",
  "setAddOn",
  "grant",
  "revokeGrant",
  "adjustMeter",
  "cancelUsage",
  "recordUsage",
  "holdUsage",
  "startHold",
  "withHold",
  "settleUsage",
  "releaseUsage",
  "snapshot",
  "subscribe",
  "cancel",
  "undoPendingChange",
  "billingPortal",
  "syncBilling",
]);

const NOW = () => new Date().toISOString();

function context(): Body {
  return {
    environment: { id: "env_test", name: "Development", kind: "test" },
    track: { id: "trk_all", name: "All customers" },
    release: 1,
    change: null,
    testers: false,
    experiment: null,
  };
}

function meter(value: Value, used: number, held: number): Body {
  const remaining: Limit = value === "unlimited" ? "unlimited" : Math.max(0, Number(value) - used - held);
  return { used, held, remaining, resetsAt: null };
}

function entitlementOf(fields: Body): Body {
  const type = (fields.type as FeatureType | undefined) ?? (fields.used === undefined ? "boolean" : "metered");
  const value = (fields.value as Value | undefined) ?? (type === "boolean" ? true : 0);
  const used = fields.used as number | undefined;
  const metered = type === "metered" ? meter(value, used ?? 0, (fields.held as number | undefined) ?? 0) : {};
  const entitled =
    fields.entitled ??
    (type === "metered"
      ? metered.remaining === "unlimited" || (metered.remaining as number) > 0
      : value === true || value === "unlimited" || (value as number) > 0);
  return { key: fields.feature ?? fields.key, type, value, entitled, sources: [], upgrades: [], ...metered, ...fields };
}

/**
 * Builders of complete answer bodies, as the API sends them, for tests that fake `fetch`: a
 * fixture missing a field would decode as `invalid_response` and pass a test for the wrong reason.
 * Each takes the fields that matter to the test and fills the rest.
 *
 * @example
 * ```ts
 * const fetch = async () => Response.json(answers.check({ feature: "export_pdf", entitled: true }));
 * ```
 */
export const answers = {
  /** A check of one feature. Pass `used` for a metered feature. */
  check(fields: { feature: string } & Body): Body {
    const { key: _, ...item } = entitlementOf(fields);
    return { ...context(), customer: "customer_1", asOf: NOW(), ...item, feature: fields.feature };
  },
  /** One item of an entitlement list. */
  entitlement(fields: { key: string } & Body): Body {
    return entitlementOf(fields);
  },
  /** An entitlement list. */
  entitlements(fields: { entitlements?: readonly Body[] } & Body = {}): Body {
    return { ...context(), customer: "customer_1", asOf: NOW(), entitlements: [], ...fields };
  },
  /** A held plan, for {@link answers}' `plans`. */
  heldPlan(fields: Body = {}): Body {
    return {
      plan: { id: "pln_free", key: "free", name: "Free", kind: "plan" },
      product: null,
      version: 1,
      byDefault: true,
      period: null,
      renewsAt: null,
      pending: null,
      billedBy: null,
      ...fields,
    };
  },
  /** A move option, for {@link answers}' `plans`. */
  moveOption(fields: Body = {}): Body {
    return {
      plan: { id: "pln_pro", key: "pro", name: "Pro", kind: "plan", description: "", default: false },
      product: null,
      from: null,
      move: "upgrade",
      action: "buy",
      reason: null,
      when: "now",
      periods: [{ key: "monthly", label: "Monthly" }],
      impact: [],
      skus: [],
      ...fields,
    };
  },
  /** The customer's plans. */
  plans(fields: Body = {}): Body {
    return { ...context(), customer: "customer_1", asOf: NOW(), held: [answers.heldPlan()], options: [], ...fields };
  },
  /** The pricing on sale. */
  pricing(fields: Body = {}): Body {
    return { ...context(), customer: null, defaultPlan: "free", products: [], plans: [], ...fields };
  },
  /** A usage write's answer. */
  usageResult(fields: { feature: string } & Body): Body {
    return {
      ...answers.check({ type: "metered", used: 0, ...fields }),
      outcome: "recorded",
      refusal: null,
      id: "use_1",
      holdId: null,
      mode: "gate",
      amount: 1,
      meterChange: 0,
      overBy: 0,
      late: false,
      occurredAt: null,
      expiresAt: null,
      reportedAs: "api",
      ...fields,
    };
  },
  /** A plan change, made now. */
  planChange(fields: Body = {}): Body {
    return {
      product: null,
      plan: { id: "pln_pro", key: "pro", name: "Pro", kind: "plan" },
      quantity: null,
      effective: "now",
      at: NOW(),
      until: null,
      changed: true,
      ...fields,
    };
  },
  /** `subscribe`'s next step: by default `done`, made now; `pay` has a checkout `url` and `manage` a `billedBy`. */
  subscribeStep(fields: Body = {}): Body {
    if (fields.next === "pay") return { url: "https://checkout.stripe.com/c/pay_1", ...fields };
    if (fields.next === "manage") return { billedBy: "apple", ...fields };
    if (fields.next === undefined || fields.next === "done") return { next: "done", ...answers.planChange(fields) };
    return fields;
  },
  /** A grant made or revoked. */
  grantChange(fields: Body = {}): Body {
    return {
      grant: {
        id: "grt_1",
        feature: "feature",
        value: "",
        from: NOW(),
        until: null,
        revokedAt: null,
        reason: "",
        by: "key",
        actor: null,
        ...fields,
      },
    };
  },
  /** A registered customer. */
  registered(fields: Body = {}): Body {
    return {
      id: "cus_1",
      externalId: "customer_1",
      environmentId: "env_test",
      createdAt: NOW(),
      created: true,
      ...fields,
    };
  },
  /** A customer token. */
  customerToken(fields: Body = {}): Body {
    return {
      token: "header.payload.signature",
      customer: "customer_1",
      scopes: ["entitlements:read"],
      expiresAt: NOW(),
      ...fields,
    };
  },
  /** One metered feature in {@link answers}' `usage`. */
  featureUsage(fields: { feature: string } & Body): Body {
    const value = (fields.value as Value | undefined) ?? 0;
    const metered = meter(value, (fields.used as number | undefined) ?? 0, (fields.held as number | undefined) ?? 0);
    const entitled = metered.remaining === "unlimited" || (metered.remaining as number) > 0;
    return { type: "metered", entitled, value, sources: [], ...metered, ...fields };
  },
  /** The customer's meters and the first page of their usage log. */
  usage(fields: Body = {}): Body {
    return {
      ...context(),
      customer: "customer_1",
      asOf: NOW(),
      metersStartAgainAt: null,
      features: [],
      log: { items: [], next: null },
      ...fields,
    };
  },
  /** A customer as a list, an update or the details show them. */
  customerSummary(fields: Body = {}): Body {
    return {
      id: "cus_1",
      externalId: "customer_1",
      name: "Customer",
      email: "customer@example.com",
      environmentId: "env_test",
      sample: false,
      createdAt: NOW(),
      plan: null,
      plans: [],
      defaultPlan: null,
      status: "active",
      kind: "default",
      metadata: {},
      track: { id: "trk_all", name: "All customers" },
      testCustomer: true,
      ...fields,
    };
  },
  /** A page of the customer list. */
  customerPage(fields: Body = {}): Body {
    return { items: [], next: null, used: 0, limit: null, ...fields };
  },
  /** A customer's details, with the first page of their usage log. */
  details(fields: Body = {}): Body {
    return {
      customer: answers.customerSummary(),
      asOf: NOW(),
      subscription: null,
      defaultPlan: null,
      products: [],
      addOns: [],
      entitlements: [],
      banked: {},
      moveOptions: [],
      grants: [],
      usage: { items: [], next: null },
      activity: [],
      environment: context().environment,
      ...fields,
    };
  },
  /** The catalogue's features. */
  features(fields: Body = {}): Body {
    const { environment, track, release, change } = context();
    return { environment, track, release, change, features: [], ...fields };
  },
  /** The scopes a credential holds. */
  scopes(fields: Body = {}): Body {
    return { scopes: ["plans:read", "entitlements:read"], ...fields };
  },
  /** The snapshot key set. */
  snapshotKeys(fields: Body = {}): Body {
    return { keys: [], ...fields };
  },
  /** A signed snapshot. */
  snapshot(fields: Body = {}): Body {
    return { token: "header.payload.signature", expiresAt: NOW(), keyId: "key_1", ...fields };
  },
  /** The customer's track after `setTrack`. */
  customerTrack(fields: Body = {}): Body {
    return {
      customer: "customer_1",
      environmentId: "env_test",
      track: { id: "trk_all", name: "All customers" },
      source: "server",
      previousTrackId: null,
      ...fields,
    };
  },
  /** A provider page: a checkout or the billing portal. */
  providerPage(fields: Body = {}): Body {
    return { provider: "stripe", url: "https://billing.stripe.com/p/session_1", ...fields };
  },
  /** A billing sync's answer. */
  billingSync(fields: Body = {}): Body {
    return { changed: false, ...fields };
  },
  /** The payment provider's view of the customer. */
  customerBilling(fields: Body = {}): Body {
    return { provider: null, status: null, sku: null, items: 0, drift: null, products: [], ...fields };
  },
  /** A usage batch's answer: by default every event recorded. */
  batchResult(fields: { results?: readonly Body[] } & Body = {}): Body {
    const results = (fields.results ?? []).map((result, index) => ({
      index,
      outcome: "recorded",
      id: `use_${index + 1}`,
      late: false,
      error: null,
      ...result,
    }));
    const count = (outcome: string) => results.filter((result) => result.outcome === outcome).length;
    return {
      recorded: count("recorded"),
      duplicates: count("duplicate"),
      errors: count("error"),
      ...fields,
      results,
    };
  },
  /** An API error body, such as `{ code: "feature_not_found" }`. */
  error(fields: { code: string; message?: string } & Body): Body {
    return { error: { message: `The request failed with ${fields.code}.`, ...fields } };
  },
};

interface Hold {
  feature: string;
  amount: number;
  state: "open" | "settled" | "released";
  settled?: number;
  expiresAt: string;
}

interface Report {
  feature: string;
  amount: number;
  mode: string;
  cancelled: boolean;
}

type Replay = () => Response;

class Model {
  readonly meters = new Map<string, { value: Value; used: number; held: number }>();
  readonly flags = new Map<string, Value>();
  readonly holds = new Map<string, Hold>();
  readonly reports = new Map<string, Report>();
  readonly replays = new Map<string, Replay>();
  readonly id: string;
  readonly options: FakeCustomerOptions;
  #next = 0;

  constructor(values: Record<string, FakeValue>, options: FakeCustomerOptions) {
    this.id = options.id ?? "customer_1";
    this.options = options;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "object") this.meters.set(key, { value: value.value, used: value.used ?? 0, held: 0 });
      else this.flags.set(key, value);
    }
  }

  nextId(prefix: string): string {
    this.#next += 1;
    return `${prefix}_${this.#next}`;
  }

  item(key: string): Body | undefined {
    const meter = this.meters.get(key);
    if (meter) return entitlementOf({ key, type: "metered", value: meter.value, used: meter.used, held: meter.held });
    const value = this.flags.get(key);
    if (value === undefined) return undefined;
    return entitlementOf({ key, type: value === true ? "boolean" : "config", value });
  }

  usage(feature: string, fields: Body): Response {
    const meter = this.meters.get(feature);
    if (!meter) return this.notFound(feature);
    return Response.json(
      answers.usageResult({
        customer: this.id,
        feature,
        value: meter.value,
        used: meter.used,
        held: meter.held,
        ...fields,
      }),
    );
  }

  notFound(feature: string): Response {
    return Response.json(answers.error({ code: this.flags.has(feature) ? "not_metered" : "feature_not_found" }), {
      status: this.flags.has(feature) ? 400 : 404,
    });
  }

  conflict(code: string): Response {
    return Response.json(answers.error({ code }), { status: 409 });
  }

  record(body: Body, key: string | null): Response {
    const feature = body.feature as string;
    const meter = this.meters.get(feature);
    if (!meter) return this.notFound(feature);
    const amount = body.amount as number;
    const mode = (body.mode as string | undefined) ?? "gate";
    const left = meter.value === "unlimited" ? Number.POSITIVE_INFINITY : Number(meter.value) - meter.used - meter.held;
    if (mode === "gate" && amount > left) {
      return this.usage(feature, { outcome: "refused", refusal: "over_allowance", id: null, mode, amount });
    }
    meter.used += amount;
    const id = this.nextId("use");
    const report: Report = { feature, amount, mode, cancelled: false };
    this.reports.set(id, report);
    if (key) {
      this.replays.set(key, () =>
        this.usage(feature, { outcome: report.cancelled ? "cancelled" : "duplicate", id, mode, amount }),
      );
    }
    const overBy = meter.value === "unlimited" ? 0 : Math.max(0, meter.used - Number(meter.value));
    return this.usage(feature, { outcome: "recorded", id, mode, amount, meterChange: amount, overBy });
  }

  hold(body: Body, key: string | null): Response {
    const feature = body.feature as string;
    const meter = this.meters.get(feature);
    if (!meter) return this.notFound(feature);
    const amount = body.amount as number;
    const left = meter.value === "unlimited" ? Number.POSITIVE_INFINITY : Number(meter.value) - meter.used - meter.held;
    if (amount > left) return this.usage(feature, { outcome: "refused", refusal: "over_allowance", id: null, amount });
    const holdId = this.nextId("hld");
    const expiresAt = new Date(Date.now() + ((body.ttlSeconds as number | undefined) ?? 300) * 1000).toISOString();
    const hold: Hold = { feature, amount, state: "open", expiresAt };
    this.holds.set(holdId, hold);
    meter.held += amount;
    if (key) this.replays.set(key, () => this.heldAgain(holdId, hold));
    return this.usage(feature, { outcome: "held", id: null, holdId, amount, expiresAt });
  }

  heldAgain(holdId: string, hold: Hold): Response {
    const fields = { id: null, holdId, amount: hold.amount, expiresAt: hold.expiresAt };
    if (hold.state === "settled")
      return this.usage(hold.feature, { ...fields, outcome: "settled", amount: hold.settled });
    if (hold.state === "released") return this.usage(hold.feature, { ...fields, outcome: "released" });
    return this.usage(hold.feature, { ...fields, outcome: "duplicate" });
  }

  settle(holdId: string, amount: number | undefined): Response {
    const hold = this.holds.get(holdId);
    if (!hold) return Response.json(answers.error({ code: "not_found" }), { status: 404 });
    const meter = this.meters.get(hold.feature) as { used: number; held: number };
    if (amount === undefined) {
      if (hold.state === "settled") return this.conflict("hold_settled");
      if (hold.state === "open") {
        hold.state = "released";
        meter.held -= hold.amount;
      }
      return this.usage(hold.feature, { outcome: "released", id: null, holdId, amount: hold.amount });
    }
    if (hold.state === "released") return this.conflict("hold_released");
    if (hold.state === "open" && amount > hold.amount) {
      return Response.json(answers.error({ code: "invalid_amount" }), { status: 400 });
    }
    if (hold.state === "settled") {
      if (hold.settled !== amount) return this.conflict("hold_settled");
      return this.usage(hold.feature, { outcome: "duplicate", holdId, amount });
    }
    hold.state = "settled";
    hold.settled = amount;
    meter.held -= hold.amount;
    meter.used += amount;
    return this.usage(hold.feature, {
      outcome: "settled",
      id: this.nextId("use"),
      holdId,
      amount,
      meterChange: amount,
    });
  }

  cancelReport(id: string): Response {
    const report = this.reports.get(id);
    if (!report) return Response.json(answers.error({ code: "not_found" }), { status: 404 });
    const meter = this.meters.get(report.feature) as { used: number };
    const meterChange = report.cancelled ? 0 : -Math.min(report.amount, meter.used);
    meter.used += meterChange;
    report.cancelled = true;
    return this.usage(report.feature, {
      outcome: "cancelled",
      id,
      mode: report.mode,
      amount: report.amount,
      meterChange,
    });
  }

  adjust(feature: string, body: Body): Response {
    const meter = this.meters.get(feature);
    if (!meter) return this.notFound(feature);
    const before = meter.used;
    meter.used = Math.max(0, body.to === undefined ? meter.used + (body.by as number) : (body.to as number));
    const meterChange = meter.used - before;
    return this.usage(feature, { outcome: "adjusted", id: meterChange === 0 ? null : this.nextId("use"), meterChange });
  }

  meterUsage(): Body[] {
    return [...this.meters.entries()].map(([feature, meter]) =>
      answers.featureUsage({ feature, value: meter.value, used: meter.used, held: meter.held }),
    );
  }

  entitlementList(): Body[] {
    return [...this.flags.keys(), ...this.meters.keys()].sort().map((key) => this.item(key) as Body);
  }

  route(method: string, path: string, body: Body, key: string | null): Response {
    const self = `/customers/${encodeURIComponent(this.id)}`;
    const rest = path.startsWith(self) ? path.slice(self.length) : undefined;
    const json = (value: Body, status = 200) => Response.json(value, { status });
    if (rest === undefined) return json(answers.error({ code: "not_found" }), 404);
    const context = { customer: this.id };
    const parts = rest.split("/").map(decodeURIComponent);
    if (method === "GET" && parts[1] === "entitlements" && parts[2] !== undefined) {
      const item = this.item(parts[2]);
      if (!item) return json(answers.error({ code: "feature_not_found" }), 404);
      const { key: feature, ...fields } = item;
      return json(answers.check({ ...context, ...fields, feature: feature as string }));
    }
    if (method === "GET" && rest === "/entitlements") {
      return json(answers.entitlements({ ...context, entitlements: this.entitlementList() }));
    }
    if (method === "GET" && rest === "/plans") return json(this.options.plans ?? answers.plans(context));
    if (method === "GET" && rest === "/pricing") return json(this.options.pricing ?? answers.pricing(context));
    if (method === "GET" && rest === "/usage") return json(answers.usage({ ...context, features: this.meterUsage() }));
    if (method === "POST" && rest === "/usage") return this.record(body, key);
    if (method === "POST" && rest === "/usage/holds") return this.hold(body, key);
    if (method === "POST" && parts[1] === "usage" && parts[4] === "settle") {
      return this.settle(parts[3] as string, body.amount as number);
    }
    if (method === "DELETE" && parts[1] === "usage" && parts[2] === "holds")
      return this.settle(parts[3] as string, undefined);
    if (method === "DELETE" && parts[1] === "usage") return this.cancelReport(parts[2] as string);
    if (method === "POST" && parts[1] === "meters") return this.adjust(parts[2] as string, body);
    if (method === "POST" && rest === "/subscription") return json(answers.subscribeStep());
    if (rest.startsWith("/subscription") || rest === "/plan" || parts[1] === "add-ons") {
      return json(answers.planChange());
    }
    if (method === "POST" && rest === "/grants") return json(answers.grantChange({ feature: body.feature }), 201);
    if (parts[1] === "grants") return json(answers.grantChange({ id: parts[2], revokedAt: NOW() }));
    const summary = () =>
      answers.customerSummary({
        externalId: this.id,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.email === "string" ? { email: body.email } : {}),
      });
    if (method === "GET" && rest === "") {
      return json(answers.details({ customer: summary(), entitlements: this.entitlementList() }));
    }
    if (method === "PUT" && rest === "") return json(answers.registered({ externalId: this.id }));
    if (method === "PATCH" && rest === "") return json(summary());
    if (method === "DELETE" && rest === "") return new Response(null, { status: 204 });
    if (rest === "/tokens") return json(answers.customerToken(context));
    if (rest === "/snapshots") return json(answers.snapshot());
    if (rest === "/billing-portal") return json(answers.providerPage());
    if (rest === "/billing/sync") return json(answers.billingSync());
    if (rest === "/billing") return json(answers.customerBilling());
    if (rest === "/track") {
      return json(
        answers.customerTrack({
          ...context,
          track: { id: "trk_1", name: typeof body.track === "string" ? body.track : "All customers" },
        }),
      );
    }
    return json(answers.error({ code: "not_found" }), 404);
  }

  async fetch(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const key = new Headers(init.headers).get("idempotency-key");
    const replay = key ? this.replays.get(key) : undefined;
    if (replay) return replayed(replay());
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Body) : {};
    const response = this.route(init.method ?? "GET", url.pathname, body, key);
    if (!key || !response.ok || this.replays.has(key)) return response;
    const text = await response.clone().text();
    const refused = text !== "" && (JSON.parse(text) as Body).outcome === "refused";
    if (!refused) {
      const kept = response.clone();
      this.replays.set(key, () => kept.clone());
    }
    return response;
  }
}

function replayed(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Idempotent-Replayed", "true");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * A {@link ServerCustomer} that makes no request, for testing an app's own gating, usage and
 * billing code. `values` maps feature keys to a value (`true`, an amount, `"unlimited"`) or a
 * meter (`{ value, used }`). Reads answer from it, and a key it does not hold answers
 * `404 feature_not_found`, so `isEntitled` answers its default. Usage writes move the meters as
 * Entitler would: a gated report past the allowance answers `refused`, holds settle and release,
 * and a reused key replays. Other writes answer a plain success, which `answer()` replaces per
 * method. Every write is kept in `writes`.
 *
 * @example
 * ```ts
 * const customer = fakeCustomer({ export_pdf: true, ai_credits: { value: 100, used: 97 } });
 * await chargeForSummary(customer);
 * expect(customer.writes.map((write) => write.method)).toEqual(["recordUsage"]);
 * ```
 */
export function fakeCustomer(values: Record<string, FakeValue>, options: FakeCustomerOptions = {}): FakeCustomer {
  const model = new Model(values, options);
  const server = new EntitlerServer({
    key: "ent_test_fake",
    cache: false,
    maxRetries: 0,
    fetch: (input, init) => model.fetch(String(input), init ?? {}),
  });
  const customer = server.customer(model.id);
  const writes: FakeWrite[] = [];
  const overrides = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(customer as FakeCustomer, {
    get(target, property) {
      if (property === "writes") return writes;
      if (property === "answer") {
        return (method: string, fn: (...args: unknown[]) => unknown) => {
          if (typeof Reflect.get(target, method) !== "function") throw new TypeError("Name a method of the customer.");
          if (typeof fn !== "function") throw new TypeError("Pass the answer as a function.");
          overrides.set(method, fn);
        };
      }
      const value = Reflect.get(target, property);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (WRITES.has(property)) writes.push({ method: property, args });
        const override = overrides.get(property);
        return override ? Promise.resolve(override(...args)) : value.apply(target, args);
      };
    },
  });
}
