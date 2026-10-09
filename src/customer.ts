import { Entitlements, type EntitlementsInit } from "./entitlements.js";
import { SettleError, UsageRefusedError } from "./errors.js";
import { paged } from "./paging.js";
import type { Call, CallOptions, Transport, WriteOptions } from "./transport.js";
import type {
  Check,
  CustomerBilling,
  CustomerChange,
  CustomerDetails,
  CustomerProviders,
  CustomerTokenScope,
  CustomerTrack,
  CustomerUsage,
  Feature,
  FeatureType,
  IssuedCustomerToken,
  IssuedSnapshot,
  Page,
  PlanSpace,
  Pricing,
  ProviderPage,
  RegisteredCustomer,
  SkuRef,
  UsageEvent,
  UsageHold,
  UsageMode,
  UsageResult,
} from "./types.js";
import { compact, featureKey, idempotencyKeyOf, instant, planKey, requireText, wholeNumber } from "./util.js";
import { visitorOf } from "./visitor.js";

/** Options for {@link Customer.isEntitled}. */
export interface IsEntitledOptions extends CallOptions {
  /**
   * The answer when Entitler cannot be asked. Pass `false` for paid features (fail closed), and
   * `true` only where losing a sale is worse than giving the feature away (fail open).
   */
  default: boolean;
}

/** Options for {@link Customer.pricing}. */
export interface PricingOptions extends CallOptions {
  /** A visitor id from {@link newVisitorId}, to keep the visitor's experiment arm (server client only). */
  visitor?: string;
}

/** Options for {@link Customer.recordUsage}. */
export interface RecordUsageOptions extends WriteOptions {
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

/** Options for {@link Customer.holdUsage} and {@link Customer.withHold}. */
export interface HoldOptions extends WriteOptions {
  /** How long the hold lasts, 1 to 3,600 seconds. Defaults to 300. */
  ttlSeconds?: number;
}

/** What `withHold`'s work receives. */
export interface HoldContext {
  /** The hold's answer, with its `holdId` and the meter. */
  readonly hold: UsageResult;
  /** The call's signal, to pass on to the work. */
  readonly signal: AbortSignal;
}

/** Options for {@link Customer.snapshot}. */
export interface SnapshotOptions extends CallOptions {
  /** How long the snapshot lasts, in seconds; by default, and at most, the project's offline days. */
  ttlSeconds?: number;
}

/**
 * A customer, shared by both clients, so code that gates features and records usage is written
 * once: `server.customer(id)` on a server, `client.me` in an app.
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
  check<T extends FeatureType>(feature: Feature<T>, options?: CallOptions): Promise<Check<T>>;
  /** Checks one feature by key, through the answer cache. */
  check(feature: string, options?: CallOptions): Promise<Check>;
  /**
   * Answers whether the customer is entitled to the feature, and never fails because of
   * Entitler: when the check fails, it answers `default` and passes the error to `onError`.
   */
  isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean>;
  /** The customer's entitlements, groups included, through the answer cache. */
  entitlements(options?: CallOptions): Promise<Entitlements>;
  /** The plans the customer holds and the moves open to them, through the answer cache. */
  planSpace(options?: CallOptions): Promise<PlanSpace>;
  /** The pricing on sale to the customer, through the answer cache. */
  pricing(options?: PricingOptions): Promise<Pricing>;
  /** The customer's meters, and the usage log a page at a time. */
  usage(options?: CallOptions): Promise<CustomerUsage>;
  /** Records usage of a metered feature: a whole number from 1 in the feature's unit. */
  recordUsage(feature: Feature<"metered"> | string, amount: number, options?: RecordUsageOptions): Promise<UsageResult>;
  /** Holds an amount against the allowance until it is settled, released or expires. */
  holdUsage(feature: Feature<"metered"> | string, amount: number, options?: HoldOptions): Promise<UsageResult>;
  /** Settles a hold with the real amount, from 0 to the amount held. */
  settleUsage(holdId: string, amount: number, options?: WriteOptions): Promise<UsageResult>;
  /** Releases a hold. Releasing twice is safe. */
  releaseUsage(holdId: string, options?: WriteOptions): Promise<UsageResult>;
  /** Reads a hold back. */
  hold(holdId: string, options?: CallOptions): Promise<UsageHold>;
  /**
   * Holds `amount`, runs `work`, and settles the amount `work` answers (any excess is recorded
   * in `observe` mode). A refused hold never runs `work` and throws {@link UsageRefusedError};
   * when `work` fails, the hold is released and the error propagates. Answers `work`'s amount.
   *
   * @example
   * ```ts
   * await customer.withHold(features.aiCredits, 500, async ({ signal }) => (await run({ signal })).tokens);
   * ```
   */
  withHold(
    feature: Feature<"metered"> | string,
    amount: number,
    work: (context: HoldContext) => number | Promise<number>,
    options?: HoldOptions,
  ): Promise<number>;
  /** Signs the customer's entitlements for offline use. Verify it with {@link verifySnapshot}. */
  snapshot(options?: SnapshotOptions): Promise<IssuedSnapshot>;
}

/** Options for {@link ServerCustomer.register}. */
export interface RegisterOptions extends WriteOptions {
  /** The customer's name. */
  name?: string;
  /** The customer's email. */
  email?: string;
  /** The vendor's metadata, merged into what is kept. */
  metadata?: Record<string, string>;
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
export interface TokenOptions extends WriteOptions {
  /** The token's scopes; by default every scope a customer token can hold. */
  scopes?: readonly CustomerTokenScope[];
  /** How long it lasts, in seconds, at most an hour. */
  ttlSeconds?: number;
}

/** A plan by key or public id, or a SKU the customer bought, which names its own period. */
export type PlanChoice = string | { readonly sku: SkuRef };

/** Options for subscribing. */
export interface SubscribeOptions extends WriteOptions {
  /** The billing period's key; left out with a SKU, which names its own. */
  period?: string;
  /** `now`, or `end` of the current period. */
  when?: "now" | "end";
}

/** Options for a checkout. */
export interface CheckoutOptions extends WriteOptions {
  /** The billing period's key. */
  period?: string;
  /** Where the provider sends the customer after paying. */
  successUrl: string;
  /** Where the provider sends the customer after cancelling. */
  cancelUrl: string;
  /** The payment connection's id, when the environment has several. */
  connection?: string;
}

/** Options for cancelling. */
export interface CancelOptions extends WriteOptions {
  /** `now`, or `end` of the current period. */
  when?: "now" | "end";
  /** The product, when the customer holds several. */
  product?: string;
}

/** Options naming a product. */
export interface ProductOptions extends WriteOptions {
  /** The product, when the customer holds several. */
  product?: string;
}

/** Options for adding an add-on. */
export interface AddOnOptions extends WriteOptions {
  /** How many. */
  quantity?: number;
  /** The add-on it replaces. */
  replaces?: string;
  /** `now`, or `end` of the current period. */
  when?: "now" | "end";
}

/** Options for a grant. */
export interface GrantOptions extends WriteOptions {
  /** The amount granted, or `"unlimited"`; left out for an on/off feature. */
  value?: number | "unlimited";
  /** How many days it lasts; left out, or 0, for no end. */
  days?: number;
  /** Why, for the activity log. */
  reason?: string;
}

/** Changes the vendor makes on the customer's behalf, kept apart so they are never made by accident. */
export interface Vendor {
  /** Moves the customer to any plan, sales-led ones included (`selfServe` false). */
  subscribe(plan: string, options?: SubscribeOptions): Promise<CustomerChange>;
  /** Moves the customer to a SKU they bought (`selfServe` false). */
  subscribe(purchase: { readonly sku: SkuRef }, options?: Omit<SubscribeOptions, "period">): Promise<CustomerChange>;
  /** Moves the customer in Entitler only, while the payment provider keeps billing the plan they held. */
  override(plan: string, options?: SubscribeOptions): Promise<CustomerChange>;
  /** Ends an override. */
  undoOverride(options?: ProductOptions): Promise<CustomerDetails>;
  /** Starts a checkout for any plan (`selfServe` false). */
  checkout(plan: PlanChoice, options: CheckoutOptions): Promise<ProviderPage>;
  /** Adds any add-on (`selfServe` false). */
  addAddOn(plan: PlanChoice, options?: AddOnOptions): Promise<CustomerChange>;
  /** Changes an add-on's quantity (`selfServe` false). */
  setAddOnQuantity(plan: string, quantity: number, options?: WriteOptions): Promise<CustomerChange>;
  /** Grants a feature for a while, or for good. */
  grant(feature: Feature | string, options?: GrantOptions): Promise<CustomerDetails>;
  /** Revokes a grant. */
  revokeGrant(grantId: string, options?: WriteOptions): Promise<CustomerDetails>;
  /** Sets a meter's `used` amount: a correction, answered with outcome `adjusted`. */
  setMeter(feature: Feature<"metered"> | string, used: number, options?: WriteOptions): Promise<UsageResult>;
  /** Cancels a usage report: a correction, answered with outcome `cancelled`. */
  cancelUsage(usageId: string, options?: WriteOptions): Promise<UsageResult>;
}

/**
 * A customer as the server sees it: a {@link Customer} plus registration, details, tokens,
 * tracks, self-serve billing and, under `vendor`, the vendor's own actions.
 */
export interface ServerCustomer extends Customer {
  /** The customer's external id. */
  readonly id: string;
  /** Vendor actions, made on the customer's behalf. */
  readonly vendor: Vendor;
  /**
   * Registers the customer, or keeps their details current: call it at sign-up and at sign-in
   * with the latest details.
   */
  register(options?: RegisterOptions): Promise<RegisteredCustomer>;
  /** The customer's plans, add-ons, grants, entitlements and usage log. */
  details(options?: CallOptions & { cursor?: string }): Promise<CustomerDetails>;
  /** Changes the customer's details. */
  update(options: UpdateOptions): Promise<CustomerDetails["customer"]>;
  /** Deletes the customer; `erase` also removes their usage. */
  delete(options?: WriteOptions & { erase?: boolean }): Promise<CustomerDetails["customer"]>;
  /** Mints a customer token for an in-app client. */
  token(options?: TokenOptions): Promise<IssuedCustomerToken>;
  /** Puts the customer on a track, or with `null` back on All customers. */
  setTrack(trackId: string | null, options?: WriteOptions): Promise<CustomerTrack>;
  /** Subscribes the customer to a plan, as their own choice (`selfServe` true). */
  subscribe(plan: string, options?: SubscribeOptions): Promise<CustomerChange>;
  /** Subscribes the customer to a SKU they bought, as their own choice (`selfServe` true). */
  subscribe(purchase: { readonly sku: SkuRef }, options?: Omit<SubscribeOptions, "period">): Promise<CustomerChange>;
  /** Starts a checkout on the payment provider (`selfServe` true). */
  checkout(plan: PlanChoice, options: CheckoutOptions): Promise<ProviderPage>;
  /** Cancels the subscription. */
  cancel(options?: CancelOptions): Promise<CustomerDetails>;
  /** Undoes a change booked for the period's end. */
  undoPendingChange(options?: ProductOptions): Promise<CustomerDetails>;
  /** Adds an add-on (`selfServe` true). */
  addAddOn(plan: PlanChoice, options?: AddOnOptions): Promise<CustomerChange>;
  /** Changes an add-on's quantity (`selfServe` true). */
  setAddOnQuantity(plan: string, quantity: number, options?: WriteOptions): Promise<CustomerChange>;
  /** Removes an add-on. */
  removeAddOn(plan: string, options?: WriteOptions): Promise<CustomerDetails>;
  /** Undoes an add-on change booked for the period's end. */
  undoAddOnChange(plan: string, options?: WriteOptions): Promise<CustomerDetails>;
  /** The customer's billing on the payment provider. */
  billing(options?: CallOptions): Promise<CustomerBilling>;
  /** Opens the payment provider's billing portal. */
  billingPortal(options: WriteOptions & { returnUrl: string }): Promise<ProviderPage>;
  /** What each payment provider holds for the customer. */
  providers(options?: CallOptions): Promise<CustomerProviders>;
}

const NEVER = new AbortController().signal;

interface Raw {
  [key: string]: unknown;
}

function choice(plan: PlanChoice): { plan?: string; sku?: SkuRef } {
  if (typeof plan === "object" && plan !== null && "sku" in plan) {
    if (!plan.sku || typeof plan.sku !== "object") throw new TypeError("Name the plan by its id or its key.");
    return { sku: plan.sku };
  }
  return { plan: planKey(plan as string) };
}

function idOf(value: string, message: string): string {
  return encodeURIComponent(requireText(value, message));
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
    this.#path = `/customers/${id === undefined ? "me" : encodeURIComponent(id)}`;
  }

  get id(): string | undefined {
    return this.#id;
  }

  /** @internal */
  async send<T>(call: Omit<Call, "path" | "customer"> & { path?: string }): Promise<{ data: T; stale: boolean }> {
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
    options: WriteOptions | undefined,
    body?: unknown,
    query?: Record<string, string | undefined>,
    headers?: Record<string, string | undefined>,
  ): Promise<T> {
    const idempotencyKey = idempotencyKeyOf(options?.idempotencyKey);
    return (await this.send<T>({ method, path, body, query, headers, idempotencyKey, options })).data;
  }

  /** @internal */
  async read<T>(path: string, options: CallOptions | undefined, extra: Partial<Call> = {}): Promise<T> {
    return (await this.send<T>({ method: "GET", path, options, ...extra })).data;
  }

  check<T extends FeatureType>(feature: Feature<T>, options?: CallOptions): Promise<Check<T>>;
  check(feature: string, options?: CallOptions): Promise<Check>;
  async check(feature: Feature | string, options?: CallOptions): Promise<Check> {
    const answer = await this.send<Raw>({
      method: "GET",
      path: `/entitlements/${encodeURIComponent(featureKey(feature))}`,
      cached: true,
      options,
    });
    return { ...answer.data, stale: answer.stale } as unknown as Check;
  }

  async isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean> {
    if (typeof options?.default !== "boolean") throw new TypeError("Pass default as true or false.");
    featureKey(feature);
    try {
      return (await this.check(featureKey(feature), options)).entitled;
    } catch (error) {
      if (options.signal?.aborted && error === options.signal.reason) throw error;
      this.onError(error);
      return options.default;
    }
  }

  async entitlements(options?: CallOptions): Promise<Entitlements> {
    const answer = await this.send<EntitlementsInit>({
      method: "GET",
      path: "/entitlements",
      cached: true,
      options,
    });
    return new Entitlements({ ...answer.data, stale: answer.stale });
  }

  async planSpace(options?: CallOptions): Promise<PlanSpace> {
    const answer = await this.send<PlanSpace>({ method: "GET", path: "/plans", cached: true, options });
    return { ...answer.data, stale: answer.stale };
  }

  async pricing(options?: PricingOptions): Promise<Pricing> {
    const answer = await this.send<Pricing>({
      method: "GET",
      path: "/pricing",
      cached: true,
      headers: { "Entitler-Visitor": visitorOf(options?.visitor) },
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  async usage(options?: CallOptions): Promise<CustomerUsage> {
    const page = (cursor: string | undefined) =>
      this.read<CustomerUsage & { log: Page<UsageEvent> }>("/usage", options, { query: { cursor } });
    const first = await page(undefined);
    return { ...first, log: paged(async (cursor) => (await page(cursor)).log, first.log) };
  }

  async recordUsage(
    feature: Feature<"metered"> | string,
    amount: number,
    options?: RecordUsageOptions,
  ): Promise<UsageResult> {
    return this.write("POST", "/usage", options, {
      feature: featureKey(feature),
      amount: wholeNumber(amount, "amount", 1),
      ...compact({
        mode: options?.mode,
        occurredAt: instant(options?.occurredAt, "Pass occurredAt as a valid date."),
        register: options?.register,
      }),
    });
  }

  async holdUsage(feature: Feature<"metered"> | string, amount: number, options?: HoldOptions): Promise<UsageResult> {
    return this.write("POST", "/usage/holds", options, {
      feature: featureKey(feature),
      amount: wholeNumber(amount, "amount", 1),
      ...compact({ ttlSeconds: options?.ttlSeconds }),
    });
  }

  async settleUsage(holdId: string, amount: number, options?: WriteOptions): Promise<UsageResult> {
    return this.write("POST", `/usage/holds/${idOf(holdId, "Provide the id of the hold.")}/settle`, options, {
      amount: wholeNumber(amount, "amount", 0),
    });
  }

  async releaseUsage(holdId: string, options?: WriteOptions): Promise<UsageResult> {
    return this.write("DELETE", `/usage/holds/${idOf(holdId, "Provide the id of the hold.")}`, options);
  }

  async hold(holdId: string, options?: CallOptions): Promise<UsageHold> {
    return this.read(`/usage/holds/${idOf(holdId, "Provide the id of the hold.")}`, options);
  }

  async withHold(
    feature: Feature<"metered"> | string,
    amount: number,
    work: (context: HoldContext) => number | Promise<number>,
    options?: HoldOptions,
  ): Promise<number> {
    if (typeof work !== "function") throw new TypeError("Pass work as a function that answers the amount used.");
    const key = idempotencyKeyOf(options?.idempotencyKey);
    idempotencyKeyOf(`${key}:excess`);
    const hold = await this.holdUsage(feature, amount, { ...options, idempotencyKey: key });
    if (hold.outcome === "refused") throw new UsageRefusedError(hold);
    const holdId = hold.holdId as string;
    const call: CallOptions = { signal: options?.signal, timeout: options?.timeout };
    let used: number;
    try {
      used = wholeNumber(await work({ hold, signal: options?.signal ?? NEVER }), "the amount work answered", 0);
    } catch (error) {
      try {
        await this.releaseUsage(holdId, call);
      } catch (releaseError) {
        this.onError(releaseError);
      }
      throw error;
    }
    const settled = Math.min(used, hold.amount);
    try {
      await this.settleUsage(holdId, settled, call);
    } catch (error) {
      throw new SettleError(holdId, settled, error);
    }
    if (used > hold.amount) {
      await this.recordUsage(feature, used - hold.amount, {
        ...call,
        mode: "observe",
        idempotencyKey: `${key}:excess`,
      });
    }
    return used;
  }

  async snapshot(options?: SnapshotOptions): Promise<IssuedSnapshot> {
    return this.write("POST", "/snapshots", options, compact({ ttlSeconds: options?.ttlSeconds }));
  }

  /** @internal */
  onError(error: unknown): void {
    this.#transport.onError?.(error);
  }
}

/** The server's customer: the shared methods plus registration, details, billing and vendor actions. @internal */
export class ServerCustomerApi extends CustomerApi implements ServerCustomer {
  override get id(): string {
    return super.id as string;
  }
  readonly vendor: Vendor = new VendorApi(this);

  async register(options?: RegisterOptions): Promise<RegisteredCustomer> {
    const details = compact({ name: options?.name, email: options?.email, metadata: options?.metadata });
    const visitor = visitorOf(options?.visitor);
    return this.write("PUT", "", options, Object.keys(details).length ? details : undefined, undefined, {
      "Entitler-Visitor": visitor,
    });
  }

  async details(options?: CallOptions & { cursor?: string }): Promise<CustomerDetails> {
    const first = await this.#details(options?.cursor, options);
    return { ...first, usage: paged((cursor) => this.usagePage(cursor, options), first.usage) };
  }

  /** @internal */
  async usagePage(cursor: string | undefined, options: CallOptions | undefined): Promise<Page<UsageEvent>> {
    return (await this.#details(cursor, options)).usage;
  }

  #details(cursor: string | undefined, options: CallOptions | undefined) {
    return this.read<CustomerDetails & { usage: Page<UsageEvent> }>("", options, { query: { cursor } });
  }

  async update(options: UpdateOptions): Promise<CustomerDetails["customer"]> {
    return this.write(
      "PATCH",
      "",
      options,
      compact({ name: options?.name, email: options?.email, metadata: options?.metadata }),
    );
  }

  async delete(options?: WriteOptions & { erase?: boolean }): Promise<CustomerDetails["customer"]> {
    return this.write("DELETE", "", options, undefined, { erase: options?.erase ? "true" : undefined });
  }

  async token(options?: TokenOptions): Promise<IssuedCustomerToken> {
    return this.write(
      "POST",
      "/tokens",
      options,
      compact({ scopes: options?.scopes, ttlSeconds: options?.ttlSeconds }),
    );
  }

  async setTrack(trackId: string | null, options?: WriteOptions): Promise<CustomerTrack> {
    const track =
      trackId === null ? null : requireText(trackId, "Provide the id of the track, or null for All customers.");
    return this.write("PUT", "/track", options, { trackId: track });
  }

  async subscribe(plan: PlanChoice, options?: SubscribeOptions): Promise<CustomerChange> {
    return this.subscription(plan, options, true, false);
  }

  /** @internal */
  async subscription(plan: PlanChoice, options: SubscribeOptions | undefined, selfServe: boolean, override: boolean) {
    return this.write<CustomerChange>("POST", "/subscription", options, {
      ...choice(plan),
      ...compact({ period: options?.period, when: options?.when }),
      selfServe,
      ...(override ? { override } : {}),
    });
  }

  async checkout(plan: PlanChoice, options: CheckoutOptions): Promise<ProviderPage> {
    return this.checkoutAs(plan, options, true);
  }

  /** @internal */
  async checkoutAs(plan: PlanChoice, options: CheckoutOptions, selfServe: boolean): Promise<ProviderPage> {
    return this.write("POST", "/checkout", options, {
      ...choice(plan),
      ...compact({ period: options?.period }),
      successUrl: requireText(options?.successUrl, "Pass successUrl as the page to send the customer to after paying."),
      cancelUrl: requireText(
        options?.cancelUrl,
        "Pass cancelUrl as the page to send the customer to after cancelling.",
      ),
      ...compact({ connection: options?.connection }),
      selfServe,
    });
  }

  async cancel(options?: CancelOptions): Promise<CustomerDetails> {
    return this.write("DELETE", "/subscription", options, undefined, {
      when: options?.when,
      product: options?.product,
    });
  }

  async undoPendingChange(options?: ProductOptions): Promise<CustomerDetails> {
    return this.write("DELETE", "/subscription/pending", options, undefined, { product: options?.product });
  }

  async addAddOn(plan: PlanChoice, options?: AddOnOptions): Promise<CustomerChange> {
    return this.addOn(plan, options, true);
  }

  /** @internal */
  async addOn(plan: PlanChoice, options: AddOnOptions | undefined, selfServe: boolean): Promise<CustomerChange> {
    return this.write("POST", "/subscription/add-ons", options, {
      ...choice(plan),
      ...compact({
        quantity: options?.quantity === undefined ? undefined : wholeNumber(options.quantity, "quantity", 1),
        replaces: options?.replaces === undefined ? undefined : planKey(options.replaces),
        when: options?.when,
      }),
      selfServe,
    });
  }

  async setAddOnQuantity(plan: string, quantity: number, options?: WriteOptions): Promise<CustomerChange> {
    return this.quantity(plan, quantity, options, true);
  }

  /** @internal */
  async quantity(
    plan: string,
    quantity: number,
    options: WriteOptions | undefined,
    selfServe: boolean,
  ): Promise<CustomerChange> {
    return this.write("PATCH", `/subscription/add-ons/${encodeURIComponent(planKey(plan))}`, options, {
      quantity: wholeNumber(quantity, "quantity", 1),
      selfServe,
    });
  }

  async removeAddOn(plan: string, options?: WriteOptions): Promise<CustomerDetails> {
    return this.write("DELETE", `/subscription/add-ons/${encodeURIComponent(planKey(plan))}`, options);
  }

  async undoAddOnChange(plan: string, options?: WriteOptions): Promise<CustomerDetails> {
    return this.write("DELETE", `/subscription/add-ons/${encodeURIComponent(planKey(plan))}/pending`, options);
  }

  async billing(options?: CallOptions): Promise<CustomerBilling> {
    return this.read("/billing", options);
  }

  async billingPortal(options: WriteOptions & { returnUrl: string }): Promise<ProviderPage> {
    return this.write("POST", "/billing-portal", options, {
      returnUrl: requireText(options?.returnUrl, "Pass returnUrl as the page to send the customer back to."),
    });
  }

  async providers(options?: CallOptions): Promise<CustomerProviders> {
    return this.read("/providers", options);
  }
}

class VendorApi implements Vendor {
  readonly #customer: ServerCustomerApi;

  constructor(customer: ServerCustomerApi) {
    this.#customer = customer;
  }

  async subscribe(plan: PlanChoice, options?: SubscribeOptions): Promise<CustomerChange> {
    return this.#customer.subscription(plan, options, false, false);
  }

  async override(plan: string, options?: SubscribeOptions): Promise<CustomerChange> {
    return this.#customer.subscription(planKey(plan), options, false, true);
  }

  async undoOverride(options?: ProductOptions): Promise<CustomerDetails> {
    return this.#customer.write("DELETE", "/subscription/override", options, undefined, { product: options?.product });
  }

  async checkout(plan: PlanChoice, options: CheckoutOptions): Promise<ProviderPage> {
    return this.#customer.checkoutAs(plan, options, false);
  }

  async addAddOn(plan: PlanChoice, options?: AddOnOptions): Promise<CustomerChange> {
    return this.#customer.addOn(plan, options, false);
  }

  async setAddOnQuantity(plan: string, quantity: number, options?: WriteOptions): Promise<CustomerChange> {
    return this.#customer.quantity(plan, quantity, options, false);
  }

  async grant(feature: Feature | string, options?: GrantOptions): Promise<CustomerDetails> {
    const value = options?.value;
    if (value !== undefined && value !== "unlimited") wholeNumber(value, "value", 0);
    return this.#customer.write("POST", "/grants", options, {
      feature: featureKey(feature),
      ...compact({
        value: value === undefined ? undefined : String(value),
        days: options?.days === undefined ? undefined : wholeNumber(options.days, "days", 0),
        reason: options?.reason,
      }),
    });
  }

  async revokeGrant(grantId: string, options?: WriteOptions): Promise<CustomerDetails> {
    return this.#customer.write("DELETE", `/grants/${idOf(grantId, "Provide the id of the grant.")}`, options);
  }

  async setMeter(feature: Feature<"metered"> | string, used: number, options?: WriteOptions): Promise<UsageResult> {
    return this.#customer.write("PUT", `/meters/${encodeURIComponent(featureKey(feature))}`, options, {
      used: wholeNumber(used, "used", 0),
    });
  }

  async cancelUsage(usageId: string, options?: WriteOptions): Promise<UsageResult> {
    return this.#customer.write("DELETE", `/usage/${idOf(usageId, "Provide the id of the usage report.")}`, options);
  }
}
