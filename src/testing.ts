import type { ServerCustomer } from "./customer.js";
import { EntitlerServer } from "./server.js";
import type { FeatureType, Limit, Value } from "./types.js";

/** A JSON body, as the API sends it. */
export type Body = Record<string, unknown>;

/** A feature's value in {@link fakeCustomer}: on, an amount, unlimited, or a meter. */
export type FakeValue = Value | { readonly value: Value; readonly used?: number };

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

/** A {@link ServerCustomer} that makes no request, for an app's own tests. */
export interface FakeCustomer extends ServerCustomer {
  /** Every write received, in order. */
  readonly writes: readonly FakeWrite[];
  /** Replaces one method's answer: `fn` receives the call's arguments and answers in its place. */
  answer<M extends keyof ServerCustomer>(method: M, fn: (...args: unknown[]) => unknown): void;
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
  /** `subscribe`'s next step: by default `done`, made now. */
  subscribeStep(fields: Body = {}): Body {
    return fields.next === undefined || fields.next === "done"
      ? { next: "done", ...answers.planChange(fields) }
      : fields;
  },
  /** A grant made or revoked. */
  grantChange(fields: Body = {}): Body {
    return {
      grant: {
        id: "grt_1",
        feature: "feature",
        value: "true",
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

class Model {
  readonly meters = new Map<string, { value: Value; used: number; held: number }>();
  readonly flags = new Map<string, Value>();
  readonly holds = new Map<string, Hold>();
  readonly replies = new Map<string, Response>();
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

  record(body: Body): Response {
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
    const overBy = meter.value === "unlimited" ? 0 : Math.max(0, meter.used - Number(meter.value));
    return this.usage(feature, {
      outcome: "recorded",
      id: this.nextId("use"),
      mode,
      amount,
      meterChange: amount,
      overBy,
    });
  }

  hold(body: Body): Response {
    const feature = body.feature as string;
    const meter = this.meters.get(feature);
    if (!meter) return this.notFound(feature);
    const amount = body.amount as number;
    const left = meter.value === "unlimited" ? Number.POSITIVE_INFINITY : Number(meter.value) - meter.used - meter.held;
    if (amount > left) return this.usage(feature, { outcome: "refused", refusal: "over_allowance", id: null, amount });
    const holdId = this.nextId("hld");
    const expiresAt = new Date(Date.now() + ((body.ttlSeconds as number | undefined) ?? 300) * 1000).toISOString();
    this.holds.set(holdId, { feature, amount, state: "open", expiresAt });
    meter.held += amount;
    return this.usage(feature, { outcome: "held", id: null, holdId, amount, expiresAt });
  }

  settle(holdId: string, amount: number | undefined): Response {
    const hold = this.holds.get(holdId);
    if (!hold) return Response.json(answers.error({ code: "not_found" }), { status: 404 });
    if (hold.state === "released") return Response.json(answers.error({ code: "hold_released" }), { status: 409 });
    const meter = this.meters.get(hold.feature) as { used: number; held: number };
    if (amount === undefined) {
      if (hold.state === "open") {
        hold.state = "released";
        meter.held -= hold.amount;
      }
      return this.usage(hold.feature, { outcome: "released", id: null, holdId, amount: hold.amount });
    }
    if (hold.state === "settled") {
      if (hold.settled !== amount) return Response.json(answers.error({ code: "hold_settled" }), { status: 409 });
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

  adjust(feature: string, body: Body): Response {
    const meter = this.meters.get(feature);
    if (!meter) return this.notFound(feature);
    const before = meter.used;
    meter.used = Math.max(0, body.to === undefined ? meter.used + (body.by as number) : (body.to as number));
    const meterChange = meter.used - before;
    return this.usage(feature, { outcome: "adjusted", id: meterChange === 0 ? null : this.nextId("use"), meterChange });
  }

  route(method: string, path: string, body: Body): Response {
    const self = `/customers/${encodeURIComponent(this.id)}`;
    const rest = path.startsWith(self) ? path.slice(self.length) : undefined;
    const json = (value: Body, status = 200) => Response.json(value, { status });
    if (rest === undefined) return json(answers.error({ code: "not_found" }), 404);
    const context = { customer: this.id };
    const parts = rest.split("/").map(decodeURIComponent);
    if (method === "GET" && parts[1] === "entitlements" && parts[2] !== undefined) {
      const item = this.item(parts[2]);
      if (!item) return json(answers.error({ code: "feature_not_found" }), 404);
      const { key, ...fields } = item;
      return json(answers.check({ ...context, ...fields, feature: key as string }));
    }
    if (method === "GET" && rest === "/entitlements") {
      const keys = [...this.flags.keys(), ...this.meters.keys()].sort();
      return json(answers.entitlements({ ...context, entitlements: keys.map((key) => this.item(key) as Body) }));
    }
    if (method === "GET" && rest === "/plans") return json(this.options.plans ?? answers.plans(context));
    if (method === "GET" && rest === "/pricing") return json(this.options.pricing ?? answers.pricing(context));
    if (method === "GET" && rest === "/usage") {
      const meters = [...this.meters.keys()].map((key) => this.item(key) as Body);
      return json({ ...answers.entitlements(context), meters, log: { items: [], next: null } });
    }
    if (method === "POST" && rest === "/usage") return this.record(body);
    if (method === "POST" && rest === "/usage/holds") return this.hold(body);
    if (method === "POST" && parts[1] === "usage" && parts[4] === "settle") {
      return this.settle(parts[3] as string, body.amount as number);
    }
    if (method === "DELETE" && parts[1] === "usage" && parts[2] === "holds")
      return this.settle(parts[3] as string, undefined);
    if (method === "DELETE" && parts[1] === "usage") {
      return json(answers.error({ code: "not_found" }), 404);
    }
    if (method === "POST" && parts[1] === "meters") return this.adjust(parts[2] as string, body);
    if (method === "POST" && rest === "/subscription") return json(answers.subscribeStep());
    if (rest.startsWith("/subscription") || rest === "/plan" || parts[1] === "add-ons") {
      return json(answers.planChange());
    }
    if (method === "POST" && rest === "/grants") return json(answers.grantChange({ feature: body.feature }), 201);
    if (parts[1] === "grants") return json(answers.grantChange({ id: parts[2], revokedAt: NOW() }));
    if (method === "PUT" && rest === "") return json(answers.registered({ externalId: this.id }));
    if (method === "PATCH" && rest === "") return json({ externalId: this.id, ...body });
    if (method === "DELETE" && rest === "") return new Response(null, { status: 204 });
    if (rest === "/tokens") return json(answers.customerToken(context));
    if (rest === "/snapshots") return json({ token: "header.payload.signature", expiresAt: NOW(), keyId: "key_1" });
    if (rest === "/billing-portal") return json(answers.error({ code: "stale" }), 409);
    if (rest === "/billing/sync") return json({ changed: false });
    if (rest === "/track")
      return json({
        ...context,
        track: { id: "trk_1", name: body.track ?? "All customers" },
        source: "server",
        previousTrackId: null,
      });
    return json(answers.error({ code: "not_found" }), 404);
  }

  async fetch(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const key = new Headers(init.headers).get("idempotency-key");
    const replay = key ? this.replies.get(key) : undefined;
    if (replay) {
      const headers = new Headers(replay.headers);
      headers.set("Idempotent-Replayed", "true");
      return new Response(await replay.clone().text(), { status: replay.status, headers });
    }
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Body) : {};
    const response = this.route(init.method ?? "GET", url.pathname, body);
    const text = await response.clone().text();
    const refused = response.ok && text !== "" && (JSON.parse(text) as Body).outcome === "refused";
    if (key && response.ok && !refused) this.replies.set(key, response.clone());
    return response;
  }
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
