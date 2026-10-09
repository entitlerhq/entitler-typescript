import { Entitlements, type EntitlementsInit } from "./entitlements.js";
import { ApiError, UsageRefusedError, UsageReplayedError, UsageSettlementError } from "./errors.js";
import { paged } from "./paging.js";
import { isCheck } from "./shapes.js";
import {
  type Call,
  type CallOptions,
  isClosed,
  type ReadOptions,
  type Transport,
  type WriteOptions,
} from "./transport.js";
import type {
  BillingSync,
  Check,
  CustomerBilling,
  CustomerDetails,
  CustomerPlans,
  CustomerSummary,
  CustomerTokenScope,
  CustomerTrack,
  CustomerUsage,
  Feature,
  FeatureType,
  GrantChange,
  IssuedCustomerToken,
  IssuedSnapshot,
  Page,
  PlanChange,
  Pricing,
  ProviderPage,
  RegisteredCustomer,
  Replayed,
  Sku,
  SubscribeStep,
  UsageEvent,
  UsageLog,
  UsageMode,
  UsageResult,
} from "./types.js";
import {
  compact,
  featureKey,
  idempotencyKeyOf,
  instant,
  planKey,
  requiredKey,
  requireId,
  requireText,
  segment,
  wholeNumber,
} from "./util.js";
import { visitorOf } from "./visitor.js";

declare global {
  interface SymbolConstructor {
    /** The well-known symbol `await using` calls to dispose of a resource. */
    readonly asyncDispose: unique symbol;
  }
}

/** Options for {@link Customer.isEntitled}. */
export interface IsEntitledOptions extends ReadOptions {
  /**
   * The answer when Entitler cannot be asked. Pass `false` for paid features (fail closed), and
   * `true` only where losing a sale is worse than giving the feature away (fail open).
   */
  default: boolean;
}

/** Options for {@link Customer.pricing}. */
export interface PricingOptions extends ReadOptions {
  /** A visitor id from {@link newVisitorId}, to keep the visitor's experiment arm. */
  visitor?: string;
}

/** Options for {@link Customer.usage}. */
export interface UsageOptions extends CallOptions {
  /** Starts the usage log at the page a previous answer's `next` names. */
  cursor?: string;
}

/** Options every usage report and hold takes: the idempotency key is required. */
export interface UsageWriteOptions extends CallOptions {
  /**
   * A key naming the event in your own system (this message, this export request, this webhook
   * delivery), 1 to 200 printable ASCII characters. Required: the API keeps it for good, so a
   * retry from the browser, another process or a restart never charges twice.
   */
  idempotencyKey: string;
}

/** Options for {@link Customer.recordUsage}. */
export interface RecordUsageOptions extends UsageWriteOptions {
  /**
   * `gate` (the default) records only when the amount fits the allowance, else answers
   * `refused`; `observe` always records what happened, and `overBy` says how far past it is.
   */
  mode?: UsageMode;
  /** When the usage happened, so it counts in that period. */
  occurredAt?: Date | string;
  /** Registers a customer not registered yet, if the credential may register customers. */
  register?: boolean;
}

/** Options for {@link Customer.holdUsage}, {@link Customer.startHold} and {@link Customer.withHold}. */
export interface HoldOptions extends UsageWriteOptions {
  /** How long the hold lasts, 1 to 3,600 seconds. Defaults to 300. */
  ttlSeconds?: number;
}

/**
 * An open hold, from {@link Customer.startHold}. Report the amount used with `use(n)`, then call
 * `finish()` however the work ended, or `release()` for work that never ran. Only the first of
 * `finish`, `release` and disposal acts; a later call answers the first one's result.
 *
 * @example
 * ```ts
 * await using hold = await customer.startHold(features.aiCredits, 2_000, { idempotencyKey: messageId });
 * hold.use(0);
 * for await (const chunk of stream) hold.use(chunk.totalTokens);
 * await hold.finish();
 * ```
 */
export interface Hold {
  /** The hold's id. */
  readonly id: string;
  /** The amount held. */
  readonly amount: number;
  /** When the hold expires unless settled or released. */
  readonly expiresAt: Date;
  /** The hold's answer, with the meter. */
  readonly result: UsageResult;
  /** True when another caller holds the same key and may be doing the same work. */
  readonly duplicate: boolean;
  /**
   * Reports the total the work really used so far, a whole number of 0 or more, with no
   * request; a later call replaces an earlier one. Work that reports as it goes calls `use(0)`
   * before it starts, so finishing after a failure that used nothing frees the whole hold.
   */
  use(amount: number): void;
  /**
   * Ends the work, whether it succeeded, failed or was cut off: settles the amount reported (the
   * held amount when none was), records any excess in `observe` mode under the hold's key plus
   * `:excess`, and records the whole amount there when the hold expired first. Runs with its own
   * timeout, never the caller's signal. Throws {@link UsageSettlementError} when that fails.
   */
  finish(): Promise<UsageResult>;
  /** Frees the hold, recording nothing, for work that never ran. */
  release(): Promise<UsageResult>;
  /**
   * The disposal `await using` runs: when neither `finish()` nor `release()` ran, settles the amount
   * reported, else releases. A failure goes to `onError`; it never throws. Defined where the
   * runtime has `Symbol.asyncDispose`.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/** What `withHold`'s work receives. */
export interface HoldContext {
  /** The open hold, to report the amount used with `hold.use(n)` and to read `hold.duplicate`. */
  readonly hold: Hold;
  /** The call's signal, to pass on to the work. */
  readonly signal: AbortSignal;
}

/** Options for {@link Customer.snapshot}. */
export interface SnapshotOptions extends CallOptions {
  /** How long the snapshot lasts, in seconds; by default, and at most, the project's offline days. */
  ttlSeconds?: number;
}

/** Options for {@link Customer.subscribe}. */
export interface SubscribeOptions extends WriteOptions {
  /** The billing period's key, such as `monthly`. */
  period?: string;
  /** An add-on's quantity. */
  quantity?: number;
  /**
   * The page the provider sends the customer back to, whether they paid or left. Needed when the
   * next step is a web page (Stripe Checkout, 3-D Secure): a mobile app passes a universal link or
   * an app link.
   */
  returnUrl?: string;
  /** Registers a customer not registered yet, if the credential may register customers. */
  register?: boolean;
}

/** Options for {@link Customer.cancel} and {@link Customer.undoPendingChange}: at most one of `addOn` and `product`. */
export interface PlanTargetOptions extends WriteOptions {
  /** The add-on to act on, by key or public id, in place of the plan. */
  addOn?: string;
  /** The product whose plan to act on, when the customer holds several. */
  product?: string;
}

/** Options for {@link Customer.billingPortal}. */
export interface BillingPortalOptions extends CallOptions {
  /** The page the billing portal sends the customer back to. */
  returnUrl: string;
}

/**
 * A customer, shared by both clients, so code that gates features, records usage and offers the
 * customer's own billing choices is written once: `server.customer(id)` on a server, `client.me`
 * in an app.
 *
 * @example
 * ```ts
 * async function exportDocument(customer: Customer, document: Doc) {
 *   if (!(await customer.isEntitled(features.exportPdf, { default: false }))) return upgradePrompt();
 *   return renderPdf(document);
 * }
 * ```
 */
export interface Customer {
  /** The customer's external id; in an app, the id the latest answer named (`undefined` before it). */
  readonly id: string | undefined;
  /** Checks one feature, through the answer cache. A {@link Feature} constant types the answer. */
  check<T extends FeatureType>(feature: Feature<T>, options?: ReadOptions): Promise<Check<T>>;
  /** Checks one feature by key, through the answer cache. */
  check(feature: string, options?: ReadOptions): Promise<Check>;
  /**
   * Answers whether the customer is entitled to the feature, and never fails because of
   * Entitler: when the check fails, it answers `default` and passes the error to `onError`.
   */
  isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean>;
  /** The customer's entitlements, groups included, through the answer cache. */
  entitlements(options?: ReadOptions): Promise<Entitlements>;
  /**
   * The paywall's and the billing page's one read, through the answer cache: the plans held
   * (`billedBy` decides between the store's page and the billing portal) and the moves open
   * (`action` decides the button, `skus` are the store products). On the in-app client it needs the
   * organisation's customer portal capability (`409 capability_required`).
   */
  plans(options?: ReadOptions): Promise<CustomerPlans>;
  /** The pricing on sale to the customer, through the answer cache. */
  pricing(options?: PricingOptions): Promise<Pricing>;
  /** The customer's meters, and the usage log a page at a time, from `cursor` when given. */
  usage(options?: UsageOptions): Promise<CustomerUsage>;
  /** Records usage of a metered feature: a whole number from 1 in the feature's unit, under your own idempotency key. */
  recordUsage(feature: Feature<"metered">, amount: number, options: RecordUsageOptions): Promise<UsageResult>;
  /**
   * Holds `amount` before any work starts and answers a {@link Hold}, so a route can answer a
   * refusal before it streams. Throws {@link UsageRefusedError} when there is no allowance, and
   * {@link UsageReplayedError} when the key replays a hold already settled, released or expired.
   * The idempotency key is at most 193 characters, leaving room for `:excess`.
   */
  startHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Hold>;
  /**
   * Starts a hold, runs `work`, and finishes it, answering `work`'s result. When `work` fails or the
   * call is cancelled, it disposes of the hold (settling the amount `work` reported with
   * `hold.use(n)`, else releasing) and rethrows. A failed settlement throws
   * {@link UsageSettlementError} holding `work`'s result. `withHold` keeps the accounting exactly
   * once, not `work`: `work` reads `hold.duplicate` to learn that another caller is doing it.
   *
   * @example
   * ```ts
   * const reply = await customer.withHold(
   *   features.aiCredits,
   *   500,
   *   async ({ hold, signal }) => {
   *     const reply = await run({ signal });
   *     hold.use(reply.tokens);
   *     return reply;
   *   },
   *   { idempotencyKey: job.id },
   * );
   * ```
   */
  withHold<R>(
    feature: Feature<"metered">,
    amount: number,
    work: (context: HoldContext) => R | Promise<R>,
    options: HoldOptions,
  ): Promise<R>;
  /** Holds an amount and answers the hold's {@link UsageResult}, for a hold settled from another process. */
  holdUsage(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<UsageResult>;
  /** Settles a hold with the real amount, from 0 to the amount held. */
  settleUsage(holdId: string, amount: number, options?: WriteOptions): Promise<UsageResult>;
  /** Releases a hold, recording nothing. Releasing twice is safe. */
  releaseUsage(holdId: string, options?: WriteOptions): Promise<UsageResult>;
  /** Signs the customer's entitlements for offline use. Verify it with {@link verifySnapshot}. */
  snapshot(options?: SnapshotOptions): Promise<IssuedSnapshot>;
  /**
   * Moves the customer to a plan, or adds an add-on, as their own choice under self-serve rules,
   * and answers the next step: `done`, `pay` (send them to `url`), `confirming` or `manage`. A
   * declined card is an `ApiError` (`402 payment_required`). In an app it needs `billing:self`.
   *
   * @example
   * ```ts
   * const step = await customer.subscribe("pro", { period: "monthly", returnUrl });
   * if (step.next === "pay") location.assign(step.url);
   * ```
   */
  subscribe(plan: string, options?: SubscribeOptions): Promise<SubscribeStep>;
  /** Cancels the plan, or the add-on `addOn` names, as the customer's own choice; the project's policy decides when. */
  cancel(options?: PlanTargetOptions): Promise<PlanChange>;
  /** Undoes the change booked for renewal on the plan, or on the add-on `addOn` names. */
  undoPendingChange(options?: PlanTargetOptions): Promise<PlanChange>;
  /**
   * Opens the provider's page for payment details and invoices. It changes no plan, and a customer
   * the provider has never billed answers `409 stale`.
   */
  billingPortal(options: BillingPortalOptions): Promise<ProviderPage>;
  /**
   * Reads the customer's state from the provider now, so the page the customer returns to shows
   * the plan they paid for. Call it before `plans({ revalidate: true })`.
   */
  syncBilling(options?: CallOptions): Promise<BillingSync>;
}

/** Options for a server read the API answers at an instant. */
export interface AsOfOptions {
  /**
   * Reads at another instant. Needs the organisation's `as_of` capability
   * (`409 capability_required` otherwise), and shows the effects of time on the plans, grants and
   * meters in place, never an unreleased change.
   */
  asOf?: Date | string;
}

/** Options for a server read through the answer cache. */
export interface ServerReadOptions extends ReadOptions, AsOfOptions {}

/** Options for {@link ServerCustomer.isEntitled}. */
export interface ServerIsEntitledOptions extends IsEntitledOptions, AsOfOptions {}

/** Options for {@link ServerCustomer.usage}. */
export interface ServerUsageOptions extends UsageOptions, AsOfOptions {}

/** Options for {@link ServerCustomer.register}. */
export interface RegisterOptions extends WriteOptions {
  /** The customer's name. */
  name?: string;
  /** The customer's email. */
  email?: string;
  /** The vendor's metadata, merged into what is kept; a `null` value removes that key. */
  metadata?: Record<string, string | null>;
  /** The visitor id the customer had signed out, to keep their experiment arm. */
  visitor?: string;
}

/** Options for {@link ServerCustomer.update}. */
export interface UpdateOptions extends WriteOptions {
  /** The customer's name. */
  name?: string;
  /** The customer's email. */
  email?: string;
  /** Metadata to merge; a `null` value removes that key. */
  metadata?: Record<string, string | null>;
}

/** Options for {@link ServerCustomer.token}. */
export interface TokenOptions extends CallOptions {
  /**
   * The token's scopes; `entitlements:read` alone by default. Ask for `usage:write` only when the
   * app records usage itself, and `billing:self` only for people who may buy for the customer.
   */
  scopes?: readonly CustomerTokenScope[];
  /** How long it lasts, in seconds, at most an hour. */
  ttlSeconds?: number;
}

/** A plan by key or public id, or a SKU the customer bought, which names its own period. */
export type PlanChoice = string | SkuChoice;

/** A SKU the customer bought, in place of a plan. */
export interface SkuChoice {
  /** The SKU: its connector and the provider's ids. */
  readonly sku: Sku;
}

/** Options every company decision takes: who decided, and why. */
export interface CompanyOptions extends WriteOptions {
  /** Why, at most 200 characters, for the customer's activity. */
  reason?: string;
  /** The person or system that decided, 1 to 200 characters, such as a support agent's id or `hubspot`. */
  actor?: string;
}

/** Options for {@link ServerCustomer.setPlan}. */
export interface SetPlanOptions extends CompanyOptions {
  /** The billing period's key, such as `yearly`; left out with a SKU, which names its own. */
  period?: string;
  /** `now`, or `end` at renewal; the project's policy when left out. */
  when?: "now" | "end";
  /**
   * `provider` (the default) charges the change through the provider that bills the product;
   * `keep` moves the customer in Entitler while the provider keeps billing its plan; `end` ends the
   * provider's subscription when the change takes effect, as with an invoiced contract.
   */
  billing?: "provider" | "keep" | "end";
  /** An instant in the future when the customer returns to the default plan unless renewed, such as a store purchase's expiry. */
  until?: Date | string;
  /** Registers a customer not registered yet. */
  register?: boolean;
}

/** Options for {@link ServerCustomer.setAddOn}. */
export interface SetAddOnOptions extends CompanyOptions {
  /** The quantity, 0 to 10,000; `0` removes the add-on. */
  quantity: number;
  /** `now`, or `end` at renewal; the project's policy when left out. */
  when?: "now" | "end";
}

/** Options for {@link ServerCustomer.grant}. */
export interface GrantOptions extends CompanyOptions {
  /** The amount granted, 0 to 999,999,999, or `"unlimited"`; left out for an on/off feature. */
  value?: number | "unlimited";
  /** How many days it lasts, 0 to 3,650; left out, or 0, for no end. */
  days?: number;
}

/** Options for {@link ServerCustomer.adjustMeter}: exactly one of `by` and `to`, and the required idempotency key. */
export type AdjustMeterOptions = CompanyOptions & {
  /** A key naming the correction in your own system, so a double submit applies once. Required. */
  idempotencyKey: string;
} & (
    | {
        /** How far to move the meter, a whole number other than 0: `-500` gives back 500 without racing new usage. */
        by: number;
        /** Not taken with `by`. */
        to?: never;
      }
    | {
        /** The amount used to set, a whole number of 0 or more. */
        to: number;
        /** Not taken with `to`. */
        by?: never;
      }
  );

/**
 * A customer as the server sees it: a {@link Customer} plus registration, details, tokens, tracks
 * and the company's decisions, made under no self-serve rules. Its reads also take `asOf`.
 */
export interface ServerCustomer extends Customer {
  /** The customer's external id. */
  readonly id: string;
  /** Checks one feature, through the answer cache, at `asOf` when given. */
  check<T extends FeatureType>(feature: Feature<T>, options?: ServerReadOptions): Promise<Check<T>>;
  /** Checks one feature by key, through the answer cache, at `asOf` when given. */
  check(feature: string, options?: ServerReadOptions): Promise<Check>;
  /** As {@link Customer.isEntitled}, at `asOf` when given. */
  isEntitled(feature: Feature | string, options: ServerIsEntitledOptions): Promise<boolean>;
  /** As {@link Customer.entitlements}, at `asOf` when given. */
  entitlements(options?: ServerReadOptions): Promise<Entitlements>;
  /** As {@link Customer.plans}, at `asOf` when given. */
  plans(options?: ServerReadOptions): Promise<CustomerPlans>;
  /** As {@link Customer.usage}, at `asOf` when given. */
  usage(options?: ServerUsageOptions): Promise<CustomerUsage>;
  /**
   * Registers the customer, or keeps their details current: call it at sign-up and at sign-in
   * with the latest details.
   */
  register(options?: RegisterOptions): Promise<RegisteredCustomer>;
  /** The customer's plans, add-ons, grants, entitlements and usage log, at `asOf` when given. */
  details(options?: ServerUsageOptions): Promise<CustomerDetails>;
  /** Changes the customer's details. */
  update(options: UpdateOptions): Promise<CustomerSummary & Replayed>;
  /**
   * Erases the customer, as account deletion in app stores requires: ends any Stripe subscription
   * now, then erases their details, usage and events. Cancel store subscriptions through Apple or
   * Google first. Erasing twice is safe.
   */
  erase(options?: WriteOptions): Promise<void>;
  /** Mints a customer token for an in-app client: `entitlements:read` alone unless `scopes` asks for more. */
  token(options?: TokenOptions): Promise<IssuedCustomerToken>;
  /**
   * Puts the customer on a track by its name, the same in every environment, or with `null` back on
   * All customers. The server key preset lacks `tracks:assign`, so add that scope to the key.
   */
  setTrack(track: string | null, options?: WriteOptions): Promise<CustomerTrack>;
  /** The payment provider's view (status, the SKU it bills, drift), for support tools. Billing pages read `plans()`. */
  billing(options?: CallOptions): Promise<CustomerBilling>;
  /**
   * Moves the customer to any plan, sales-led ones included, or records a verified store purchase
   * by its SKU with `until` its expiry.
   *
   * @example
   * ```ts
   * await customer.setPlan("enterprise", { period: "yearly", billing: "end", actor: "hubspot", idempotencyKey: dealEventId });
   * ```
   */
  setPlan(plan: string, options?: SetPlanOptions): Promise<PlanChange>;
  /** Records a verified store purchase by its SKU, which names its own period. */
  setPlan(purchase: SkuChoice, options?: Omit<SetPlanOptions, "period">): Promise<PlanChange>;
  /** Adds an add-on, sets its quantity, or removes it at `0`. */
  setAddOn(addOn: string, options: SetAddOnOptions): Promise<PlanChange>;
  /** Grants a feature for a while, or for good, and answers the grant made so a support tool keeps its id. */
  grant(feature: Feature | string, options?: GrantOptions): Promise<GrantChange>;
  /** Revokes a grant, and answers it. */
  revokeGrant(grantId: string, options?: CompanyOptions): Promise<GrantChange>;
  /** Moves a meter by `by`, or sets it `to` an amount; it never goes below 0. Answers outcome `adjusted`. */
  adjustMeter(feature: Feature<"metered">, options: AdjustMeterOptions): Promise<UsageResult>;
  /** Cancels a usage report: a correction, answered with outcome `cancelled`. */
  cancelUsage(usageId: string, options?: CompanyOptions): Promise<UsageResult>;
}

const UNCHANGING = new Set(["/tokens", "/snapshots", "/billing-portal"]);
const USAGE_AMOUNT = `Pass amount as a whole number from 1 to ${Number.MAX_SAFE_INTEGER}.`;
const SETTLED_AMOUNT = "Pass amount as a whole number from 0 to the held amount.";
const AMOUNT_USED = "Pass the amount used as a whole number of 0 or more.";
const ADJUSTMENT = "Pass either by, a whole number other than 0, or to, a whole number of 0 or more.";
const STEPS = new Set(["done", "pay", "confirming", "manage"]);

/** Checks a usage amount. @internal */
export function usageAmount(amount: unknown): number {
  return wholeNumber(amount, "amount", 1, Number.MAX_SAFE_INTEGER, USAGE_AMOUNT);
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A usage log from its first page. @internal */
export function usageLog(first: Page<UsageEvent>, fetchPage: (cursor: string) => Promise<Page<UsageEvent>>): UsageLog {
  const all = paged((cursor) => (cursor === undefined ? Promise.resolve(first) : fetchPage(cursor)));
  return { items: first.items, next: first.next, pages: all.pages, [Symbol.asyncIterator]: all[Symbol.asyncIterator] };
}

interface Raw {
  [key: string]: unknown;
}

function choice(plan: PlanChoice): { plan?: string; sku?: Sku } {
  if (typeof plan === "object" && plan !== null && "sku" in plan) {
    if (!plan.sku || typeof plan.sku !== "object") throw new TypeError("Name the plan by its id or its key.");
    return { sku: plan.sku };
  }
  return { plan: planKey(plan as string) };
}

function idOf(value: string, message: string): string {
  return segment(requireId(value, message));
}

function stepOf(data: Raw, replayed: boolean): SubscribeStep {
  const next = data.next;
  if (typeof next === "string" && STEPS.has(next)) {
    return (next === "done" ? { ...data, replayed } : data) as unknown as SubscribeStep;
  }
  return { next: "unknown", raw: String(next) };
}

function isStep(data: Raw): boolean {
  if (typeof data.next !== "string") return false;
  if (data.next === "pay") return typeof data.url === "string";
  if (data.next === "manage") return typeof data.billedBy === "string";
  if (data.next === "done") return typeof data.changed === "boolean" && typeof data.effective === "string";
  return true;
}

function asOfHeader(options: AsOfOptions | undefined): Record<string, string | undefined> {
  return { "Entitler-As-Of": instant(options?.asOf, "Pass asOf as a valid date.") };
}

/** The customer methods both clients share, on the path `/customers/{id}`. @internal */
export class CustomerApi implements Customer {
  readonly #transport: Transport;
  readonly #path: string;
  readonly #self: boolean;
  #id: string | undefined;

  constructor(transport: Transport, id: string | undefined) {
    this.#transport = transport;
    this.#self = id === undefined;
    this.#id = id;
    this.#path = `/customers/${id === undefined ? "me" : segment(id)}`;
  }

  get id(): string | undefined {
    return this.#id;
  }

  /** @internal */
  get transport(): Transport {
    return this.#transport;
  }

  /** @internal */
  async send<T>(
    call: Omit<Call, "path" | "customer"> & { path?: string },
  ): Promise<{ data: T; stale: boolean; replayed: boolean }> {
    const answer = await this.#transport.send<T>({
      ...call,
      path: this.#path + (call.path ?? ""),
      customer: this.#path,
    });
    const customer = (answer.data as Raw | undefined)?.customer;
    if (this.#self && typeof customer === "string") this.#id = customer;
    return answer;
  }

  /** @internal */
  async write<T>(
    method: Call["method"],
    path: string,
    options: CallOptions | undefined,
    body?: unknown,
    extra: Partial<Call> & { key?: string } = {},
  ): Promise<T & Replayed> {
    const { key, ...call } = extra;
    const idempotencyKey = key ?? idempotencyKeyOf((options as WriteOptions | undefined)?.idempotencyKey);
    const changes = UNCHANGING.has(path) ? [] : [this.#path];
    const answer = await this.send<T>({ method, path, body, idempotencyKey, changes, options, ...call });
    return { ...answer.data, replayed: answer.replayed };
  }

  /** @internal */
  async read<T>(path: string, options: CallOptions | undefined, extra: Partial<Call> = {}): Promise<T> {
    return (await this.send<T>({ method: "GET", path, options, ...extra })).data;
  }

  /** @internal */
  async cached<T>(
    path: string,
    options: ReadOptions | undefined,
    extra: Partial<Call> = {},
  ): Promise<T & { stale: boolean }> {
    const answer = await this.send<T>({
      method: "GET",
      path,
      cached: true,
      revalidate: options?.revalidate,
      options,
      ...extra,
    });
    return { ...answer.data, stale: answer.stale };
  }

  check<T extends FeatureType>(feature: Feature<T>, options?: ServerReadOptions): Promise<Check<T>>;
  check(feature: string, options?: ServerReadOptions): Promise<Check>;
  async check(feature: Feature | string, options?: ServerReadOptions): Promise<Check> {
    return this.cached<Check>(`/entitlements/${segment(featureKey(feature))}`, options, {
      shape: isCheck,
      headers: this.asOf(options),
    });
  }

  async isEntitled(feature: Feature | string, options: ServerIsEntitledOptions): Promise<boolean> {
    if (typeof options?.default !== "boolean") throw new TypeError("Pass default as true or false.");
    const key = featureKey(feature);
    const headers = this.asOf(options);
    try {
      return (await this.cached<Check>(`/entitlements/${segment(key)}`, options, { shape: isCheck, headers })).entitled;
    } catch (error) {
      if ((options.signal?.aborted && error === options.signal.reason) || isClosed(error)) throw error;
      this.onError(error);
      return options.default;
    }
  }

  async entitlements(options?: ServerReadOptions): Promise<Entitlements> {
    return new Entitlements(
      await this.cached<EntitlementsInit>("/entitlements", options, { headers: this.asOf(options) }),
    );
  }

  async plans(options?: ServerReadOptions): Promise<CustomerPlans> {
    return this.cached<CustomerPlans>("/plans", options, { headers: this.asOf(options) });
  }

  async pricing(options?: PricingOptions): Promise<Pricing> {
    return this.cached<Pricing>("/pricing", options, { headers: { "Entitler-Visitor": visitorOf(options?.visitor) } });
  }

  async usage(options?: ServerUsageOptions): Promise<CustomerUsage> {
    const headers = this.asOf(options);
    const page = (cursor: string | undefined) =>
      this.read<CustomerUsage & { log: Page<UsageEvent> }>("/usage", options, { query: { cursor }, headers });
    const first = await page(options?.cursor);
    return { ...first, log: usageLog(first.log, async (cursor) => (await page(cursor)).log) };
  }

  async recordUsage(feature: Feature<"metered">, amount: number, options: RecordUsageOptions): Promise<UsageResult> {
    const key = requiredKey(options?.idempotencyKey);
    return this.write<UsageResult>(
      "POST",
      "/usage",
      options,
      {
        feature: featureKey(feature),
        amount: usageAmount(amount),
        ...compact({
          mode: options.mode,
          occurredAt: instant(options.occurredAt, "Pass occurredAt as a valid date."),
          register: options.register,
        }),
      },
      { key },
    );
  }

  async holdUsage(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<UsageResult> {
    const key = requiredKey(options?.idempotencyKey);
    return this.write<UsageResult>(
      "POST",
      "/usage/holds",
      options,
      { feature: featureKey(feature), amount: usageAmount(amount), ...compact({ ttlSeconds: options.ttlSeconds }) },
      { key },
    );
  }

  async settleUsage(holdId: string, amount: number, options?: WriteOptions): Promise<UsageResult> {
    return this.write<UsageResult>(
      "POST",
      `/usage/holds/${idOf(holdId, "Provide the id of the hold.")}/settle`,
      options,
      {
        amount: wholeNumber(amount, "amount", 0, Number.MAX_SAFE_INTEGER, SETTLED_AMOUNT),
      },
    );
  }

  async releaseUsage(holdId: string, options?: WriteOptions): Promise<UsageResult> {
    return this.write<UsageResult>("DELETE", `/usage/holds/${idOf(holdId, "Provide the id of the hold.")}`, options);
  }

  async startHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Hold> {
    const key = requiredKey(options?.idempotencyKey, 193);
    const answer = await this.holdUsage(feature, amount, { ...options, idempotencyKey: key });
    if (answer.outcome === "refused") throw new UsageRefusedError(answer);
    const open =
      (answer.outcome === "held" || answer.outcome === "duplicate") &&
      answer.holdId !== null &&
      answer.expiresAt !== null &&
      answer.expiresAt.getTime() > Date.now();
    if (!open) throw new UsageReplayedError(answer);
    return this.#handle(feature, key, answer, options.timeout);
  }

  #handle(feature: Feature<"metered">, key: string, answer: UsageResult, timeout: number | undefined): Hold {
    const holdId = answer.holdId as string;
    let used: number | undefined;
    let first: Promise<UsageResult> | undefined;
    const call = (): CallOptions => ({
      signal: AbortSignal.timeout(timeout ?? this.#transport.timeout),
      ...(timeout === undefined ? {} : { timeout }),
    });
    const settle = async (): Promise<UsageResult> => {
      const total = used ?? answer.amount;
      const settled = Math.min(total, answer.amount);
      const excess = total > answer.amount ? total - answer.amount : undefined;
      const observe = (amount: number) =>
        this.recordUsage(feature, amount, { ...call(), mode: "observe", idempotencyKey: `${key}:excess` });
      let unrecorded = excess;
      try {
        let result: UsageResult;
        try {
          result = await this.settleUsage(holdId, settled, call());
        } catch (error) {
          if (!(error instanceof ApiError && error.code === "hold_expired") || total === 0) throw error;
          unrecorded = total;
          return await observe(total);
        }
        if (excess !== undefined) await observe(excess);
        return result;
      } catch (cause) {
        throw new UsageSettlementError({ holdId, amount: settled, excess: unrecorded, result: undefined, cause });
      }
    };
    const release = () => this.releaseUsage(holdId, call());
    const act = (action: () => Promise<UsageResult>) => {
      first ??= action();
      return first;
    };
    const dispose = async (): Promise<void> => {
      if (first) return;
      try {
        await act(used === undefined ? release : settle);
      } catch (error) {
        this.onError(error);
      }
    };
    return {
      id: holdId,
      amount: answer.amount,
      expiresAt: answer.expiresAt as Date,
      result: answer,
      duplicate: answer.outcome === "duplicate",
      use(value: number) {
        used = wholeNumber(value, "the amount used", 0, Number.MAX_SAFE_INTEGER, AMOUNT_USED);
      },
      finish: () => act(settle),
      release: () => act(release),
      ...(typeof Symbol.asyncDispose === "symbol" ? { [Symbol.asyncDispose]: dispose } : {}),
      [DISPOSE]: dispose,
    } as Hold;
  }

  async withHold<R>(
    feature: Feature<"metered">,
    amount: number,
    work: (context: HoldContext) => R | Promise<R>,
    options: HoldOptions,
  ): Promise<R> {
    if (typeof work !== "function") throw new TypeError("Pass work as a function.");
    const hold = await this.startHold(feature, amount, options);
    const signal = options.signal;
    let result: R;
    try {
      result = await untilAborted(
        Promise.resolve(work({ hold, signal: signal ?? new AbortController().signal })),
        signal,
      );
    } catch (error) {
      await (hold as Hold & { [DISPOSE]: () => Promise<void> })[DISPOSE]();
      throw error;
    }
    try {
      await hold.finish();
    } catch (error) {
      if (!(error instanceof UsageSettlementError)) throw error;
      throw new UsageSettlementError({
        holdId: error.holdId,
        amount: error.amount,
        excess: error.excess,
        result,
        cause: error.cause,
      });
    }
    return result;
  }

  async snapshot(options?: SnapshotOptions): Promise<IssuedSnapshot> {
    const { replayed: _, ...snapshot } = await this.write<IssuedSnapshot>(
      "POST",
      "/snapshots",
      options,
      compact({ ttlSeconds: options?.ttlSeconds }),
    );
    return snapshot;
  }

  async subscribe(plan: string, options?: SubscribeOptions): Promise<SubscribeStep> {
    const body = {
      plan: planKey(plan),
      ...compact({
        period: options?.period,
        quantity: options?.quantity === undefined ? undefined : wholeNumber(options.quantity, "quantity", 1),
        returnUrl: options?.returnUrl,
        register: options?.register,
      }),
    };
    const { replayed, ...data } = await this.write<Raw>("POST", "/subscription", options, body, { shape: isStep });
    return stepOf(data, replayed);
  }

  async cancel(options?: PlanTargetOptions): Promise<PlanChange> {
    return this.#target("", options);
  }

  async undoPendingChange(options?: PlanTargetOptions): Promise<PlanChange> {
    return this.#target("/pending", options);
  }

  #target(suffix: string, options: PlanTargetOptions | undefined): Promise<PlanChange> {
    if (options?.addOn !== undefined && options.product !== undefined) {
      throw new TypeError("Pass either addOn or product, not both.");
    }
    if (options?.addOn !== undefined) {
      return this.write<PlanChange>(
        "DELETE",
        `/subscription/add-ons/${segment(planKey(options.addOn))}${suffix}`,
        options,
      );
    }
    return this.write<PlanChange>("DELETE", `/subscription${suffix}`, options, undefined, {
      query: { product: options?.product },
    });
  }

  async billingPortal(options: BillingPortalOptions): Promise<ProviderPage> {
    const { replayed: _, ...page } = await this.write<ProviderPage>("POST", "/billing-portal", options, {
      returnUrl: requireText(options?.returnUrl, "Pass returnUrl as the page to send the customer back to."),
    });
    return page;
  }

  async syncBilling(options?: CallOptions): Promise<BillingSync> {
    const { replayed: _, ...sync } = await this.write<BillingSync>("POST", "/billing/sync", options);
    return sync;
  }

  /** @internal */
  asOf(options: AsOfOptions | undefined): Record<string, string | undefined> {
    return this.#self ? {} : asOfHeader(options);
  }

  /** @internal */
  onError(error: unknown): void {
    this.#transport.report(error);
  }
}

const DISPOSE = Symbol("dispose");

/** The server's customer: the shared methods plus registration, details and the company's decisions. @internal */
export class ServerCustomerApi extends CustomerApi implements ServerCustomer {
  override get id(): string {
    return super.id as string;
  }

  async register(options?: RegisterOptions): Promise<RegisteredCustomer> {
    const details = compact({ name: options?.name, email: options?.email, metadata: options?.metadata });
    return this.write<RegisteredCustomer>("PUT", "", options, Object.keys(details).length ? details : undefined, {
      headers: { "Entitler-Visitor": visitorOf(options?.visitor) },
    });
  }

  async details(options?: ServerUsageOptions): Promise<CustomerDetails> {
    const first = await this.#details(options?.cursor, options);
    return { ...first, usage: usageLog(first.usage, (cursor) => this.usagePage(cursor, options)) };
  }

  /** @internal */
  async usagePage(cursor: string | undefined, options: ServerUsageOptions | undefined): Promise<Page<UsageEvent>> {
    return (await this.#details(cursor, options)).usage;
  }

  #details(cursor: string | undefined, options: ServerUsageOptions | undefined) {
    return this.read<CustomerDetails & { usage: Page<UsageEvent> }>("", options, {
      query: { cursor },
      headers: asOfHeader(options),
    });
  }

  async update(options: UpdateOptions): Promise<CustomerSummary & Replayed> {
    return this.write<CustomerSummary>(
      "PATCH",
      "",
      options,
      compact({ name: options?.name, email: options?.email, metadata: options?.metadata }),
    );
  }

  async erase(options?: WriteOptions): Promise<void> {
    await this.write("DELETE", "", options, undefined, { query: { erase: "true" }, empty: true });
  }

  async token(options?: TokenOptions): Promise<IssuedCustomerToken> {
    const { replayed: _, ...token } = await this.write<IssuedCustomerToken>(
      "POST",
      "/tokens",
      options,
      compact({ scopes: options?.scopes, ttlSeconds: options?.ttlSeconds }),
    );
    return token;
  }

  async setTrack(track: string | null, options?: WriteOptions): Promise<CustomerTrack> {
    return this.write<CustomerTrack>("PUT", "/track", options, {
      track: track === null ? null : requireText(track, "Name the track by its name."),
    });
  }

  async billing(options?: CallOptions): Promise<CustomerBilling> {
    return this.read("/billing", options);
  }

  async setPlan(plan: PlanChoice, options?: SetPlanOptions): Promise<PlanChange> {
    return this.write<PlanChange>("PUT", "/plan", options, {
      ...choice(plan),
      ...compact({
        period: options?.period,
        when: options?.when,
        billing: options?.billing,
        until: instant(options?.until, "Pass until as a valid date."),
        register: options?.register,
        reason: options?.reason,
        actor: options?.actor,
      }),
    });
  }

  async setAddOn(addOn: string, options: SetAddOnOptions): Promise<PlanChange> {
    return this.write<PlanChange>("PUT", `/add-ons/${segment(planKey(addOn))}`, options, {
      quantity: wholeNumber(options?.quantity, "quantity", 0, 10_000),
      ...compact({ when: options.when, reason: options.reason, actor: options.actor }),
    });
  }

  async grant(feature: Feature | string, options?: GrantOptions): Promise<GrantChange> {
    const value = options?.value;
    if (value !== undefined && value !== "unlimited") wholeNumber(value, "value", 0, 999_999_999);
    return this.write<GrantChange>("POST", "/grants", options, {
      feature: featureKey(feature),
      ...compact({
        value: value === undefined ? undefined : String(value),
        days: options?.days === undefined ? undefined : wholeNumber(options.days, "days", 0, 3650),
        reason: options?.reason,
        actor: options?.actor,
      }),
    });
  }

  async revokeGrant(grantId: string, options?: CompanyOptions): Promise<GrantChange> {
    return this.write<GrantChange>(
      "DELETE",
      `/grants/${idOf(grantId, "Provide the id of the grant.")}`,
      options,
      this.#who(options),
    );
  }

  async adjustMeter(feature: Feature<"metered">, options: AdjustMeterOptions): Promise<UsageResult> {
    const key = requiredKey(options?.idempotencyKey);
    const { by, to } = options as { by?: unknown; to?: unknown };
    const max = Number.MAX_SAFE_INTEGER;
    const valid =
      by !== undefined
        ? to === undefined && Number.isInteger(by) && by !== 0 && Math.abs(by as number) <= max
        : Number.isInteger(to) && (to as number) >= 0 && (to as number) <= max;
    if (!valid) throw new TypeError(ADJUSTMENT);
    return this.write<UsageResult>(
      "POST",
      `/meters/${segment(featureKey(feature))}/adjustments`,
      options,
      { ...(by === undefined ? { to } : { by }), ...this.#who(options) },
      { key },
    );
  }

  async cancelUsage(usageId: string, options?: CompanyOptions): Promise<UsageResult> {
    return this.write<UsageResult>(
      "DELETE",
      `/usage/${idOf(usageId, "Provide the id of the usage report.")}`,
      options,
      this.#who(options),
    );
  }

  #who(options: CompanyOptions | undefined): { reason?: string; actor?: string } | undefined {
    const who = compact({ reason: options?.reason, actor: options?.actor });
    return Object.keys(who).length ? who : undefined;
  }
}
