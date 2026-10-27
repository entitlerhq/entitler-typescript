import type { CheckOptions, EndPlanOptions, ServerCustomer, SetPlanOptions } from "./customer.js";
import { EntitlerServer } from "./server.js";
import type { Feature, Limit } from "./types.js";

/** A metered feature in {@link fakeCustomer}: its allowance and how much is used. */
export interface FakeMeter {
  /** The allowance. */
  readonly value: Limit;
  /** How much is used. Defaults to 0. */
  readonly used?: number;
}

/** A feature in {@link fakeCustomer}: `true` for a switch, a configuration's amount, or a meter. */
export type FakeValue = true | Limit | FakeMeter;

/** Options for {@link fakeCustomer}. */
export interface FakeCustomerOptions {
  /** The customer's external id. Defaults to `customer_1`. */
  id?: string;
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

/** A replacement for one method: it takes that method's arguments and answers its result. */
export type FakeAnswer<M extends CustomerMethod> = ServerCustomer[M] extends (...args: infer A) => infer R
  ? M extends "check"
    ? (feature: Feature | string, options?: CheckOptions) => R | Awaited<R>
    : M extends "setPlan"
      ? (plan: string | null, options?: SetPlanOptions | EndPlanOptions) => R | Awaited<R>
      : (...args: A) => R | Awaited<R>
  : never;

/** A {@link ServerCustomer} that makes no request, for an app's own tests. */
export interface FakeCustomer extends ServerCustomer {
  /** Every write received, in order. */
  readonly writes: readonly FakeWrite[];
  /** Replaces one method's answer: `fn` receives the call's arguments and answers in its place. */
  answer<M extends CustomerMethod>(method: M, fn: NoInfer<FakeAnswer<M>>): void;
}

const MODELLED = new Set<string>([
  "check",
  "isEntitled",
  "entitlements",
  "recordUsage",
  "holdUsage",
  "startHold",
  "withHold",
  "settleUsage",
  "releaseUsage",
  "cancelUsage",
]);

const READS = new Set<string>(["check", "isEntitled", "entitlements", "plans", "pricing", "details", "billing"]);

type Body = Record<string, unknown>;

interface ModelFeature {
  readonly type: "switch" | "configuration" | "metered";
  readonly value: true | Limit;
  used: number;
  held: number;
}

interface HoldState {
  readonly feature: string;
  readonly amount: number;
  readonly expiresAt: number;
  state: "open" | "settled" | "released" | "expired";
}

interface Report {
  readonly feature: string;
  readonly amount: number;
  cancelled: boolean;
}

const limit = (value: Limit): Body => (value === "unlimited" ? { unlimited: {} } : { count: value });

const failure = (status: number, code: string, reason: string): Response =>
  Response.json({ error: { code, reason, parameters: {} } }, { status });

class Model {
  readonly #id: string;
  readonly #features = new Map<string, ModelFeature>();
  readonly #holds = new Map<string, HoldState>();
  readonly #reports = new Map<string, Report>();
  readonly #keys = new Map<string, { request: string; answer: Body }>();
  #next = 0;

  constructor(id: string, values: Record<string, FakeValue>) {
    this.#id = id;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "object") {
        this.#features.set(key, { type: "metered", value: value.value, used: value.used ?? 0, held: 0 });
      } else {
        this.#features.set(key, { type: value === true ? "switch" : "configuration", value, used: 0, held: 0 });
      }
    }
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = decodeURIComponent(url.pathname).replace(`/v1/customers/${this.#id}`, "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Body) : {};
    this.#expire();
    if (method === "GET" && path === "/entitlements") {
      return Response.json({
        ...this.#context(),
        entitlements: [...this.#features.keys()].map((key) => this.#entitlement(key)),
      });
    }
    const check = /^\/entitlements\/(.+)$/.exec(path);
    if (method === "GET" && check) {
      const key = check[1] as string;
      if (!this.#features.has(key)) return failure(404, "NotFound", "FEATURE_NOT_FOUND");
      return Response.json({ ...this.#context(), entitlement: this.#entitlement(key) });
    }
    if (method === "POST" && path === "/usage") return this.#keyed(body, () => this.#report(body));
    if (method === "POST" && path === "/usage/holds") return this.#keyed(body, () => this.#hold(body));
    const settle = /^\/usage\/holds\/(.+):settle$/.exec(path);
    if (method === "POST" && settle) return this.#settle(settle[1] as string, Number(body.amount ?? 0));
    const release = /^\/usage\/holds\/(.+)$/.exec(path);
    if (method === "DELETE" && release) return this.#release(release[1] as string);
    const cancel = /^\/usage\/(.+):cancel$/.exec(path);
    if (method === "POST" && cancel) return this.#cancel(cancel[1] as string);
    return failure(501, "Unimplemented", "NOT_FAKED");
  };

  #context(): Body {
    return {
      asOf: Math.floor(Date.now() / 1000),
      customer: { customerId: "cu_fake", externalId: this.#id },
      served: { release: { id: "rl_fake", number: 1 } },
    };
  }

  #left(feature: ModelFeature): number {
    return feature.value === "unlimited"
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Number(feature.value) - feature.used - feature.held);
  }

  #entitlement(key: string): Body {
    const feature = this.#features.get(key) as ModelFeature;
    const base = { featureKey: key, sources: [], upgrades: [], decimals: 0, currency: "" };
    if (feature.type === "switch") {
      return { ...base, kind: "ENTITLED_FEATURE_KIND_SWITCH", entitled: true, value: { switch: true } };
    }
    const value = feature.value as Limit;
    if (feature.type === "configuration") {
      return {
        ...base,
        kind: "ENTITLED_FEATURE_KIND_CONFIGURATION",
        entitled: value === "unlimited" || value > 0,
        value: { configuration: limit(value) },
      };
    }
    const left = this.#left(feature);
    return {
      ...base,
      kind: "ENTITLED_FEATURE_KIND_METERED",
      entitled: left > 0,
      value: { metered: limit(value) },
      meter: {
        used: feature.used,
        held: feature.held,
        banked: 0,
        remaining: limit(left === Number.POSITIVE_INFINITY ? "unlimited" : left),
      },
    };
  }

  #answer(key: string, usage: Body): Body {
    return {
      tracked: {
        ...this.#context(),
        entitlement: this.#entitlement(key),
        usage: {
          mode: "USAGE_MODE_GATE",
          meterChange: 0,
          overBy: 0,
          late: false,
          replayed: false,
          saturated: false,
          ...usage,
        },
      },
    };
  }

  #keyed(body: Body, write: () => Response | Body): Response {
    const key = String(body.idempotencyKey);
    const request = JSON.stringify(body);
    const kept = this.#keys.get(key);
    if (kept) {
      if (kept.request !== request) return failure(400, "FailedPrecondition", "IDEMPOTENCY_KEY_REUSED");
      const tracked = kept.answer.tracked as Body;
      const usage = tracked.usage as Body;
      const open = typeof usage.holdId === "string" && this.#holds.get(usage.holdId)?.state === "open";
      const outcome = open ? "USAGE_OUTCOME_DUPLICATE" : usage.outcome;
      return Response.json({ tracked: { ...tracked, usage: { ...usage, outcome, replayed: true } } });
    }
    const answer = write();
    if (answer instanceof Response) return answer;
    this.#keys.set(key, { request, answer });
    return Response.json(answer);
  }

  #metered(key: string): ModelFeature | Response {
    const feature = this.#features.get(key);
    if (!feature) return failure(404, "NotFound", "FEATURE_NOT_FOUND");
    if (feature.type !== "metered") return failure(400, "FailedPrecondition", "USAGE_FEATURE_NOT_METERED");
    return feature;
  }

  #refusal(feature: ModelFeature, amount: number): string | undefined {
    if (feature.value === 0) return "USAGE_REFUSAL_NOT_ENTITLED";
    return amount > this.#left(feature) ? "USAGE_REFUSAL_OVER_ALLOWANCE" : undefined;
  }

  #report(body: Body): Response | Body {
    const key = String(body.featureKey);
    const feature = this.#metered(key);
    if (feature instanceof Response) return feature;
    const amount = Number(body.amount);
    const observe = body.mode === "USAGE_MODE_OBSERVE";
    const refusal = observe ? undefined : this.#refusal(feature, amount);
    if (refusal) return this.#answer(key, { outcome: "USAGE_OUTCOME_REFUSED", refusal, amount });
    feature.used += amount;
    const id = `us_fake_${++this.#next}`;
    this.#reports.set(id, { feature: key, amount, cancelled: false });
    const overBy = feature.value === "unlimited" ? 0 : Math.max(0, feature.used + feature.held - Number(feature.value));
    return this.#answer(key, {
      outcome: "USAGE_OUTCOME_RECORDED",
      mode: observe ? "USAGE_MODE_OBSERVE" : "USAGE_MODE_GATE",
      usageId: id,
      amount,
      meterChange: amount,
      overBy,
    });
  }

  #hold(body: Body): Response | Body {
    const key = String(body.featureKey);
    const feature = this.#metered(key);
    if (feature instanceof Response) return feature;
    const amount = Number(body.amount);
    const refusal = this.#refusal(feature, amount);
    if (refusal) return this.#answer(key, { outcome: "USAGE_OUTCOME_REFUSED", refusal, amount });
    feature.held += amount;
    const id = `ho_fake_${++this.#next}`;
    const expiresAt = Date.now() + Number(body.ttlSeconds ?? 300) * 1000;
    this.#holds.set(id, { feature: key, amount, expiresAt, state: "open" });
    return this.#answer(key, { outcome: "USAGE_OUTCOME_HELD", holdId: id, amount, expiresAtMs: expiresAt });
  }

  #open(id: string): HoldState | Response {
    const hold = this.#holds.get(id);
    if (!hold) return failure(404, "NotFound", "HOLD_NOT_FOUND");
    if (hold.state !== "open") return failure(400, "FailedPrecondition", `HOLD_${hold.state.toUpperCase()}`);
    return hold;
  }

  #settle(id: string, amount: number): Response {
    const hold = this.#open(id);
    if (hold instanceof Response) return hold;
    if (amount > hold.amount) return failure(400, "InvalidArgument", "USAGE_AMOUNT_INVALID");
    const feature = this.#features.get(hold.feature) as ModelFeature;
    hold.state = "settled";
    feature.held -= hold.amount;
    feature.used += amount;
    const usageId = `us_fake_${++this.#next}`;
    this.#reports.set(usageId, { feature: hold.feature, amount, cancelled: false });
    return Response.json(
      this.#answer(hold.feature, {
        outcome: "USAGE_OUTCOME_SETTLED",
        holdId: id,
        usageId,
        amount,
        meterChange: amount,
      }),
    );
  }

  #release(id: string): Response {
    const hold = this.#open(id);
    if (hold instanceof Response) return hold;
    hold.state = "released";
    (this.#features.get(hold.feature) as ModelFeature).held -= hold.amount;
    return Response.json(this.#answer(hold.feature, { outcome: "USAGE_OUTCOME_RELEASED", holdId: id, amount: 0 }));
  }

  #cancel(id: string): Response {
    const report = this.#reports.get(id);
    if (!report) return failure(404, "NotFound", "USAGE_NOT_FOUND");
    const replayed = report.cancelled;
    if (!replayed) (this.#features.get(report.feature) as ModelFeature).used -= report.amount;
    report.cancelled = true;
    return Response.json(
      this.#answer(report.feature, {
        outcome: "USAGE_OUTCOME_CANCELLED",
        usageId: id,
        amount: report.amount,
        meterChange: replayed ? 0 : -report.amount,
        replayed,
      }),
    );
  }

  #expire(): void {
    for (const hold of this.#holds.values()) {
      if (hold.state === "open" && hold.expiresAt <= Date.now()) {
        hold.state = "expired";
        (this.#features.get(hold.feature) as ModelFeature).held -= hold.amount;
      }
    }
  }
}

/**
 * A customer for an app's own tests, holding the features passed and making no request. `check`,
 * `entitlements`, usage reports, holds and `cancelUsage` behave as against Entitler: gated reports
 * and holds are refused past the allowance, and an idempotency key repeats its first answer. Give
 * any other method's answer with `answer()`. `writes` lists every write received.
 *
 * @example
 * ```ts
 * const customer = fakeCustomer({ export_pdf: true, ai_credits: { value: 1_000, used: 990 } });
 * await expect(chat(customer, "hello")).rejects.toBeInstanceOf(UsageRefusedError);
 * ```
 */
export function fakeCustomer(values: Record<string, FakeValue>, options?: FakeCustomerOptions): FakeCustomer {
  const id = options?.id ?? "customer_1";
  const model = new Model(id, values);
  const customer = new EntitlerServer({
    key: "sk_test_fake",
    fetch: model.fetch,
    cache: false,
    maxRetries: 0,
  }).customer(id);
  const writes: FakeWrite[] = [];
  const answers = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(customer, {
    get(target, property, receiver) {
      if (property === "writes") return writes;
      if (property === "answer") {
        return (method: string, fn: (...args: unknown[]) => unknown) => {
          answers.set(method, fn);
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (!READS.has(property)) writes.push({ method: property, args });
        const replacement = answers.get(property);
        if (replacement) return replacement(...args);
        if (!MODELLED.has(property)) {
          throw new Error(`fakeCustomer doesn't model ${property}(); give its answer with answer("${property}", fn).`);
        }
        return (value as (...given: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as FakeCustomer;
}
