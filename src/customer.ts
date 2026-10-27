import { Entitlements, type EntitlementsInit } from "./entitlements.js";
import { ApiError, UsageRefusedError, UsageReplayedError, UsageSettlementError } from "./errors.js";
import { type CustomerPricingOptions, readPricing } from "./pricing.js";
import { type Operation, route } from "./routes.js";
import {
  type Decoder,
  decodeBilling,
  decodeCheck,
  decodeCustomer,
  decodeCustomerPricing,
  decodeEntitlements,
  decodeGrant,
  decodeMove,
  decodeNothing,
  decodePlans,
  decodePortal,
  decodeRegistered,
  decodeRevokedGrant,
  decodeSnapshot,
  decodeSync,
  decodeToken,
  decodeTrack,
  decodeUsage,
  scopeEnum,
} from "./shapes.js";
import { type Answer, type CallOptions, isClosed, type ReadOptions, type Transport } from "./transport.js";
import type {
  Check,
  CustomerBilling,
  CustomerPlans,
  CustomerPricing,
  CustomerRecord,
  CustomerTokenScope,
  Feature,
  FeatureType,
  GrantResult,
  IssuedCustomerToken,
  Limit,
  MoveStep,
  Open,
  RegisteredCustomer,
  RevokedGrant,
  Snapshot,
  TrackAssignment,
  UsageMode,
  UsageResult,
} from "./types.js";
import { featureKey, requiredKey, requireId, timerDelay, untilAborted, wholeNumber } from "./util.js";

/** Options for a customer's reads. */
export interface CheckOptions extends ReadOptions {
  /**
   * Answers as of this instant instead of now, in a test environment whose plan allows the test
   * clock. A live environment refuses it with `AS_OF_NOT_ALLOWED`.
   */
  asOf?: Date;
}

/** Options for {@link Customer.isEntitled}. */
export interface IsEntitledOptions extends CheckOptions {
  /**
   * The answer when Entitler cannot be asked. Pass `false` for paid features (fail closed), and
   * `true` only where losing a sale is worse than giving the feature away (fail open).
   */
  default: boolean;
}

/** Options every usage report and hold takes: the idempotency key is required. */
export interface UsageWriteOptions extends CallOptions {
  /**
   * A key naming the event in your own system (this message, this export request, this webhook
   * delivery), 1 to 200 printable ASCII characters. Required: the API keeps it, so a retry from
   * another process or after a restart never charges twice.
   */
  idempotencyKey: string;
  /**
   * The lower-case currency code the amount counts in, for a money feature: it must be the
   * customer's, the `currency` its entitlement answers. Leave it out for any other feature.
   */
  currency?: string;
}

/** Options for {@link Customer.recordUsage}. */
export interface RecordUsageOptions extends UsageWriteOptions {
  /**
   * `gate` (the default) records only when the amount fits the allowance, else answers
   * `refused`; `observe` always records what happened, and `overBy` says how far past it is.
   */
  mode?: UsageMode;
  /** When the usage happened, so it counts in that period. */
  occurredAt?: Date;
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
 * await using hold = await customer.startHold(aiCredits, 2_000, { idempotencyKey: messageId });
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

/** A customer, named by the id your app uses for them. */
export interface Customer {
  /** The id your app uses for the customer. */
  readonly id: string;
  /**
   * Checks one feature: Entitler's decision, the value, the meter for a metered feature, where the
   * value comes from and the plans that would give it.
   *
   * @example
   * ```ts
   * const check = await customer.check("ai_credits");
   * if (!check.entitled) showUpgrade(check.upgrades);
   * ```
   */
  check<T extends FeatureType>(feature: Feature<T>, options?: CheckOptions): Promise<Check<T>>;
  /** Checks one feature by its key. */
  check(feature: string, options?: CheckOptions): Promise<Check>;
  /**
   * Answers Entitler's decision for one feature, or `default` when Entitler cannot be asked. Never
   * throws for a failed request; only a cancelled or closed call rejects.
   */
  isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean>;
  /** Lists every entitlement the customer holds, groups included. */
  entitlements(options?: CheckOptions): Promise<Entitlements>;
  /**
   * Asks Entitler to sign a snapshot of the customer's entitlements, to check them offline with
   * `verifySnapshot` until it expires. Store the token in the app's own storage.
   *
   * @example
   * ```ts
   * const snapshot = await entitler.me.snapshot({ ttlSeconds: 86_400 });
   * await storage.set("entitler-snapshot", snapshot.token);
   * ```
   */
  snapshot(options?: SnapshotOptions): Promise<Snapshot>;
  /**
   * Reads the customer's pricing: the plans on sale to them on their track, in their market, and
   * what they pay now for each subscription, discounts and coming charges included.
   */
  pricing(options?: CustomerPricingOptions): Promise<CustomerPricing>;
  /**
   * Moves the customer to a plan, or adds an add-on, as their own choice under self-serve rules,
   * and answers the next step. In an app it needs the `billing:self` scope. Never retried.
   *
   * @example
   * ```ts
   * const step = await customer.subscribe("pro", { period: "pe_monthly", returnUrl });
   * if (step.next === "pay") location.assign(step.url);
   * ```
   */
  subscribe(plan: string, options?: SubscribeOptions): Promise<MoveStep>;
  /**
   * Reads the plans the customer can move to, each with what moving would do, and what they hold
   * now: a lane per product with its plan, add-ons, dates and booked changes, and their grants.
   * In an app it needs the `billing:self` scope.
   */
  plans(options?: CheckOptions): Promise<CustomerPlans>;
  /**
   * Opens the payment provider's page for payment details and invoices, and answers its `url`. It
   * changes no plan. In an app it needs the `billing:self` scope and the customer portal on the
   * team's plan, and takes one call every 10 seconds per customer.
   */
  billingPortal(options: BillingPortalOptions): Promise<{ readonly url: string }>;
  /**
   * Reads the customer's state from the payment provider now, so the page they return to after
   * paying shows the plan they paid for, then read `plans()`. In an app it needs the `billing:self`
   * scope and the customer portal on the team's plan, and takes one call every 10 seconds per customer.
   */
  syncBilling(options?: CallOptions): Promise<{ readonly changed: boolean }>;
  /** Cancels the customer's subscription as their own choice; the project's policy decides when. */
  cancel(options?: CancelOptions): Promise<MoveStep>;
  /** Undoes the change booked for the customer's next renewal. */
  undoPendingChange(options?: ProductMoveOptions): Promise<MoveStep>;
  /**
   * Records usage of a metered feature. A refusal in `gate` mode is an answer (`outcome:
   * "refused"`), not an error.
   *
   * @example
   * ```ts
   * const result = await customer.recordUsage(exports, 1, { idempotencyKey: job.id });
   * if (result.outcome === "refused") showUpgrade(result.upgrades);
   * ```
   */
  recordUsage(feature: Feature<"metered">, amount: number, options: RecordUsageOptions): Promise<UsageResult>;
  /**
   * Holds an amount while work runs, opens a {@link Hold} for it, and throws
   * {@link UsageRefusedError} when the customer has too little left.
   */
  startHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Hold>;
  /**
   * Holds an amount, runs `work`, then settles what `work` reported with `hold.use(n)`, or the whole
   * hold when it reported nothing. When `work` throws, settles what it reported or frees the hold.
   * When the call is cancelled, rejects at once and closes the hold once `work` stops, or when the
   * hold expires if `work` never does. When another caller holds the same key (`hold.duplicate`),
   * runs `work` but leaves the hold to that caller, so `work` can check it and return early. Throws
   * {@link UsageRefusedError} before `work` runs when the customer has too little left, and
   * {@link UsageSettlementError} holding `work`'s result when settling fails.
   *
   * @example
   * ```ts
   * const reply = await customer.withHold(
   *   aiCredits,
   *   2_000,
   *   async ({ hold, signal }) => {
   *     const answer = await model.generate(prompt, { signal });
   *     hold.use(answer.usage.totalTokens);
   *     return answer.text;
   *   },
   *   { idempotencyKey: messageId },
   * );
   * ```
   */
  withHold<R>(
    feature: Feature<"metered">,
    amount: number,
    work: (context: HoldContext) => R | Promise<R>,
    options: HoldOptions,
  ): Promise<R>;
  /** Holds an amount, answering the refusal instead of throwing; the building block of `startHold`. */
  holdUsage(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<UsageResult>;
  /** Settles a hold with the amount really used, from 0 to the held amount. */
  settleUsage(holdId: string, amount: number, options?: CallOptions): Promise<UsageResult>;
  /** Frees a hold, recording nothing. */
  releaseUsage(holdId: string, options?: CallOptions): Promise<UsageResult>;
}

/** The details `register()` and `update()` set. */
export interface CustomerDetailsInput {
  /** The customer's name. */
  name?: string;
  /** The customer's email. */
  email?: string;
  /** Attributes to set, merged into those kept; a `null` value removes that attribute. */
  attributes?: Record<string, string | null>;
}

/** Options for {@link ServerCustomer.register}. */
export interface RegisterOptions extends CustomerDetailsInput, CallOptions {
  /** The visitor id the customer had while signed out, so they keep their experiment arm. */
  visitor?: string;
}

/** Options for {@link ServerCustomer.update}. */
export interface UpdateOptions extends CustomerDetailsInput, CallOptions {}

/** Options for {@link Customer.snapshot}. */
export interface SnapshotOptions extends CallOptions {
  /**
   * How long the snapshot verifies, 60 seconds to 30 days. Defaults to the project's offline
   * allowance, which also caps it.
   */
  ttlSeconds?: number;
}

/** Options for {@link ServerCustomer.token}. */
export interface TokenOptions extends CallOptions {
  /**
   * What the token lets the app do; `entitlements:read` alone by default. Ask for `usage:write` only
   * when the app records usage itself, and `billing:self` only for people who may buy for the customer.
   */
  scopes?: readonly CustomerTokenScope[];
  /** How long the token lasts, 60 to 3,600 seconds. Defaults to 3,600. */
  ttlSeconds?: number;
}

/** A change to a customer's record that fails when the record has moved on since it was read. */
export interface RevisionOptions extends CallOptions {
  /** Why, kept with the change and shown in the dashboard. */
  reason?: string;
  /**
   * The customer's revision this change was decided on. When the record has changed since, the
   * write fails with `ApiError` and changes nothing.
   */
  expectedRevision?: number;
}

/** Options for {@link ServerCustomer.grant}. */
export interface GrantOptions extends RevisionOptions {
  /**
   * `true` for a switch; for a metered or configuration feature, the amount in the feature's
   * smallest unit, or `"unlimited"`.
   */
  value: true | Limit;
  /** How many days the grant lasts, 1 to 3,650. Leave it out for a grant that lasts until revoked. */
  days?: number;
  /** The customer's lower-case currency code, for a money feature. Leave it out for any other feature. */
  currency?: string;
}

/** Options for {@link ServerCustomer.adjustMeter}: exactly one of `setTo` and `changeBy`. */
export type AdjustMeterOptions = CallOptions & {
  /** Why, kept with the adjustment. */
  reason?: string;
  /** A key naming the adjustment in your own system, so a retry never adjusts twice. */
  idempotencyKey?: string;
  /** The customer's lower-case currency code, for a money feature. Leave it out for any other feature. */
  currency?: string;
} & ({ setTo: number; changeBy?: never } | { changeBy: number; setTo?: never });

/** Options for {@link ServerCustomer.cancelUsage}. */
export interface CancelUsageOptions extends CallOptions {
  /** Why, kept with the cancellation. */
  reason?: string;
}

/** Where to price a move: a market by its key, or the market of a country. */
interface PlaceOptions {
  /** The key of the market to price the plan in. */
  market?: string;
  /** The ISO 3166-1 country code whose market prices the plan, when `market` is left out. */
  country?: string;
}

/** Options for {@link Customer.subscribe}. */
export interface SubscribeOptions extends CallOptions, PlaceOptions {
  /** The id of the billing period to buy, such as monthly or yearly. Defaults to the plan's first. */
  period?: string;
  /** How many seats or units to buy. */
  quantity?: number;
  /** An offer the customer takes, by its key or by a code they typed. */
  offer?: { key: string } | { code: string };
  /** Where the payment provider sends the customer back to after paying. */
  returnUrl?: string;
  /** Registers a customer not registered yet, if the credential may register customers. */
  register?: boolean;
}

/** Options for a move in one product. */
export interface ProductMoveOptions extends RevisionOptions {
  /** The product's id. Leave it out when the project has one product. */
  product?: string;
}

/** Options for {@link Customer.cancel}. */
export interface CancelOptions extends ProductMoveOptions {
  /** When the subscription ends. Leave it out for the project's cancellation policy to decide. */
  endsAt?: Date;
}

/** An offer the company gives with a plan, at its own value or at the value passed. */
export interface OfferChoice {
  /** The offer's key. */
  key: string;
  /** A fixed amount off, in the currency's smallest unit, instead of the offer's own. */
  amount?: number;
  /** A percentage off in thousandths of a percent, such as 12_500 for 12.5 %, instead of the offer's own. */
  percentThousandths?: number;
}

/** Options for {@link ServerCustomer.setPlan} when moving to a plan. */
export interface SetPlanOptions extends RevisionOptions, PlaceOptions {
  /** The id of the billing period to move to. Defaults to the one the customer holds, else the plan's first. */
  period?: string;
  /** `now`, or `period_end` to book the move for renewal. The project's policy decides when left out. */
  when?: Open<"now" | "period_end">;
  /** When the plan ends, such as a store purchase's expiry. */
  until?: Date;
  /** Offers given with the plan. */
  offers?: readonly OfferChoice[];
  /** Moves the customer to the plan's latest version even when they hold an earlier one. */
  latestVersion?: boolean;
  /** Keeps the payment provider billing as it does, so the move changes only entitlements. */
  keepBilling?: boolean;
  /** Ends the payment provider's billing for the plan the customer leaves. */
  endBilling?: boolean;
  /** Waives the exit fees and charge-backs leaving early would cost. */
  waiveExitCharges?: boolean;
  /** Registers a customer not registered yet. */
  register?: boolean;
}

/** Options for {@link ServerCustomer.setPlan} when ending the plan in a product. */
export interface EndPlanOptions extends RevisionOptions {
  /** The id of the product whose plan ends. */
  product: string;
  /** `now`, or `period_end` to end it at renewal. The project's policy decides when left out. */
  when?: Open<"now" | "period_end">;
  /** Ends the payment provider's billing for the plan. */
  endBilling?: boolean;
  /** Waives the exit fees and charge-backs leaving early would cost. */
  waiveExitCharges?: boolean;
}

/** Options for {@link ServerCustomer.setAddOn}. */
export interface SetAddOnOptions extends RevisionOptions {
  /** How many to hold. Defaults to 1. */
  quantity?: number;
  /** The key of an add-on this one replaces. */
  replaces?: string;
  /** Registers a customer not registered yet. */
  register?: boolean;
}

/** Options for {@link Customer.billingPortal}. */
export interface BillingPortalOptions extends CallOptions {
  /** Where the provider's page sends the customer back to. */
  returnUrl: string;
}

/** A customer from the server client: everything an app's customer does, plus their record and tokens. */
export interface ServerCustomer extends Customer {
  /**
   * Registers the customer, or keeps their details current: call it at sign-up, and at sign-in with
   * the latest details. Registering twice is safe.
   */
  register(options?: RegisterOptions): Promise<RegisteredCustomer>;
  /** Reads the customer's record. */
  details(options?: CallOptions): Promise<CustomerRecord>;
  /** Changes the customer's details. */
  update(options: UpdateOptions): Promise<CustomerRecord>;
  /**
   * Erases the customer, as account deletion in app stores requires: their details, usage and
   * events. Cancel store subscriptions through Apple or Google first. Erasing twice is safe.
   */
  erase(options?: CallOptions): Promise<void>;
  /**
   * Mints a customer token for an in-app client, `entitlements:read` alone unless `scopes` asks for
   * more. Hand it to your own signed-in app only.
   *
   * @example
   * ```ts
   * const { token } = await entitler.customer(user.id).token({ scopes: ["entitlements:read", "usage:write"] });
   * ```
   */
  token(options?: TokenOptions): Promise<IssuedCustomerToken>;
  /**
   * Gives the customer a feature value outside their plans, for `days` or until revoked.
   *
   * @example
   * ```ts
   * await customer.grant("ai_credits", { value: 5_000, days: 30, reason: "Support ticket 4127" });
   * ```
   */
  grant(feature: Feature | string, options: GrantOptions): Promise<GrantResult>;
  /**
   * Ends a grant now. Revoking twice is safe: the second answers `changed: false`. Retries a
   * revocation that failed on the way, unless it passes `expectedRevision`: a first revocation moves
   * the revision on, so a retry or a second call with the same `expectedRevision` fails with `ApiError`.
   */
  revokeGrant(grantId: string, options?: RevisionOptions): Promise<RevokedGrant>;
  /** Moves the customer to a track, or back to the default track with `null`. */
  setTrack(trackId: string | null, options?: CallOptions): Promise<TrackAssignment>;
  /** Sets a metered feature's meter to an amount, or moves it by one, outside usage reports. */
  adjustMeter(feature: Feature<"metered"> | string, options: AdjustMeterOptions): Promise<UsageResult>;
  /** Cancels a usage report, giving back what it used. Cancelling twice is safe. */
  cancelUsage(usageId: string, options?: CancelUsageOptions): Promise<UsageResult>;
  /**
   * Moves the customer to any plan, sales-led ones included, by its key.
   *
   * @example
   * ```ts
   * await customer.setPlan("enterprise", { period: "pe_yearly", when: "now", reason: "Signed order 118" });
   * ```
   */
  setPlan(plan: string, options?: SetPlanOptions): Promise<MoveStep>;
  /** Ends the customer's plan in `product`: they move to its default plan, or hold none. */
  setPlan(plan: null, options: EndPlanOptions): Promise<MoveStep>;
  /** Adds an add-on by its key, or sets how many the customer holds, taking effect now. */
  setAddOn(addOn: string, options?: SetAddOnOptions): Promise<MoveStep>;
  /** Removes an add-on. */
  removeAddOn(addOn: string, options?: RevisionOptions): Promise<MoveStep>;
  /** Undoes the change booked for an add-on at renewal. */
  undoAddOnChange(addOn: string, options?: RevisionOptions): Promise<MoveStep>;
  /**
   * Reads the payment provider's view of the customer, for support tools; a customer the provider
   * doesn't know answers `linked: false`. Billing pages read `plans()`.
   */
  billing(options?: CallOptions): Promise<CustomerBilling>;
}

function details(options: CustomerDetailsInput | undefined): Record<string, unknown> {
  const attributes = Object.entries(options?.attributes ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => (value === null ? { key } : { key, value }));
  return {
    ...(options?.name === undefined ? {} : { name: options.name }),
    ...(options?.email === undefined ? {} : { email: options.email }),
    ...(attributes.length === 0 ? {} : { attributes }),
  };
}

function currency(options: { currency?: string }): { currency?: string } {
  if (options.currency === undefined) return {};
  if (typeof options.currency !== "string") throw new TypeError("Pass currency as a currency code.");
  return { currency: options.currency };
}

function revision(options: RevisionOptions | undefined): Record<string, unknown> {
  return {
    ...(options?.reason === undefined ? {} : { reason: options.reason }),
    ...(options?.expectedRevision === undefined
      ? {}
      : { expectedRevision: { value: wholeNumber(options.expectedRevision, "expectedRevision", 0) } }),
  };
}

function grantValue(value: unknown): Record<string, unknown> {
  if (value === true) return { on: {} };
  if (value === "unlimited") return { limit: { unlimited: {} } };
  return { limit: { count: wholeNumber(value, "value", 0, Number.MAX_SAFE_INTEGER, GRANT_VALUE) } };
}

function adjustment(options: AdjustMeterOptions): Record<string, number> {
  const { setTo, changeBy } = options ?? {};
  if ((setTo === undefined) === (changeBy === undefined))
    throw new TypeError("Pass exactly one of setTo and changeBy.");
  if (setTo !== undefined) return { setTo: wholeNumber(setTo, "setTo", 0) };
  return { changeBy: wholeNumber(changeBy, "changeBy", Number.MIN_SAFE_INTEGER) };
}

function epochSeconds(value: unknown, name: string): number {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`Pass ${name} as a valid date.`);
  return Math.floor(value.getTime() / 1000);
}

function place(options: PlaceOptions | undefined): Record<string, string> {
  if (options?.market !== undefined && options.country !== undefined) {
    throw new TypeError("Pass market or country, not both.");
  }
  return {
    ...(options?.market === undefined ? {} : { market: options.market }),
    ...(options?.country === undefined ? {} : { country: options.country }),
  };
}

function when(value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { when: `SUBSCRIPTION_MOVE_WHEN_${value.toUpperCase()}` };
}

function flags(options: object | undefined, names: readonly string[]): Record<string, true> {
  const given = (options ?? {}) as Record<string, unknown>;
  return Object.fromEntries(names.filter((name) => given[name] === true).map((name) => [name, true]));
}

function offerChoice(offer: OfferChoice): Record<string, unknown> {
  const value = {
    ...(offer.amount === undefined ? {} : { amount: wholeNumber(offer.amount, "amount", 0) }),
    ...(offer.percentThousandths === undefined
      ? {}
      : { percentThousandths: wholeNumber(offer.percentThousandths, "percentThousandths", 0, 100_000) }),
  };
  const key = requireId(offer?.key, "Name each offer by its key.");
  return Object.keys(value).length === 0 ? { offerKey: key } : { offerKey: key, value };
}

const SNAPSHOT_SECONDS = 30 * 24 * 60 * 60;

const USAGE_AMOUNT = `Pass amount as a whole number from 1 to ${Number.MAX_SAFE_INTEGER}.`;
const GRANT_VALUE = 'Pass value as true, "unlimited" or a whole number of 0 or more.';
const SETTLED_AMOUNT = "Pass amount as a whole number from 0 to the held amount.";
const AMOUNT_USED = "Pass the amount used as a whole number of 0 or more.";
const EXCESS = ":excess";
const DISPOSE = Symbol("dispose");

function disposeOnceStopped(work: Promise<unknown>, expiresIn: number, dispose: () => Promise<void>): void {
  const expiry = setTimeout(dispose, timerDelay(expiresIn));
  (expiry as { unref?: () => void }).unref?.();
  const stopped = () => {
    clearTimeout(expiry);
    void dispose();
  };
  work.then(stopped, stopped);
}

function asOf(options: CheckOptions | undefined): Record<string, string | undefined> {
  const given = options?.asOf;
  if (given === undefined) return {};
  if (!(given instanceof Date) || Number.isNaN(given.getTime())) throw new TypeError("Pass asOf as a valid date.");
  return { as_of: String(Math.floor(given.getTime() / 1000)) };
}

/** A customer's methods over the transport. @internal */
export class CustomerApi implements ServerCustomer {
  readonly id: string;
  readonly #transport: Transport;

  constructor(transport: Transport, id: string) {
    this.#transport = transport;
    this.id = id;
  }

  async #cached<T>(
    operation: Operation,
    variables: Record<string, string>,
    options: CheckOptions | undefined,
    decode: Decoder,
  ): Promise<T & { stale: boolean }> {
    const answer = await this.#transport.send<T>({
      ...route(operation, { external_id: this.id, ...variables }, asOf(options)),
      customer: this.id,
      cached: true,
      revalidate: options?.revalidate,
      decode,
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  check<T extends FeatureType>(feature: Feature<T>, options?: CheckOptions): Promise<Check<T>>;
  check(feature: string, options?: CheckOptions): Promise<Check>;
  async check(feature: Feature | string, options?: CheckOptions): Promise<Check> {
    const check = await this.#cached<Check>(
      "Entitlements.CheckFeature",
      { feature_key: featureKey(feature) },
      options,
      decodeCheck,
    );
    if (typeof feature === "object" && feature.type !== check.type) {
      throw new TypeError(`${check.key} is declared ${feature.type}, but Entitler answers it as ${check.type}.`);
    }
    return check;
  }

  async isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean> {
    if (typeof options?.default !== "boolean") throw new TypeError("Pass default as true or false.");
    this.#transport.checkTimeout(options);
    const key = featureKey(feature);
    asOf(options);
    try {
      return (await this.check(key, options)).entitled;
    } catch (error) {
      if ((options.signal?.aborted && error === options.signal.reason) || isClosed(error)) throw error;
      this.#transport.report(error);
      return options.default;
    }
  }

  async entitlements(options?: CheckOptions): Promise<Entitlements> {
    return new Entitlements(
      await this.#cached<EntitlementsInit>("Entitlements.ListEntitlements", {}, options, decodeEntitlements),
    );
  }

  #usage(
    operation: Operation,
    variables: Record<string, string>,
    body: Record<string, unknown> | undefined,
    options: CallOptions | undefined,
    idempotencyKey?: string,
    retryable = true,
  ): Promise<Answer<UsageResult>> {
    return this.#transport.send<UsageResult>({
      ...route(operation, { external_id: this.id, ...variables }),
      customer: this.id,
      body,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      retryable,
      decode: decodeUsage,
      options,
    });
  }

  async recordUsage(feature: Feature<"metered">, amount: number, options: RecordUsageOptions): Promise<UsageResult> {
    const idempotencyKey = requiredKey(options?.idempotencyKey);
    const occurredAt = options.occurredAt;
    if (occurredAt !== undefined && (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime()))) {
      throw new TypeError("Pass occurredAt as a valid date.");
    }
    const body = {
      featureKey: featureKey(feature),
      amount: wholeNumber(amount, "amount", 1, Number.MAX_SAFE_INTEGER, USAGE_AMOUNT),
      idempotencyKey,
      ...(options.mode === undefined ? {} : { mode: `USAGE_MODE_${options.mode.toUpperCase()}` }),
      ...(occurredAt === undefined ? {} : { occurredAtMs: occurredAt.getTime() }),
      ...(options.register === undefined ? {} : { register: options.register }),
      ...currency(options),
    };
    return (await this.#usage("Usage.ReportUsage", {}, body, options, idempotencyKey)).data;
  }

  async holdUsage(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<UsageResult> {
    return (await this.#createHold(feature, amount, options)).data;
  }

  #createHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Answer<UsageResult>> {
    const idempotencyKey = requiredKey(options?.idempotencyKey);
    const body = {
      featureKey: featureKey(feature),
      amount: wholeNumber(amount, "amount", 1, Number.MAX_SAFE_INTEGER, USAGE_AMOUNT),
      idempotencyKey,
      ...(options.ttlSeconds === undefined
        ? {}
        : { ttlSeconds: wholeNumber(options.ttlSeconds, "ttlSeconds", 1, 3600) }),
      ...currency(options),
    };
    return this.#usage("Usage.CreateHold", {}, body, options, idempotencyKey);
  }

  async settleUsage(holdId: string, amount: number, options?: CallOptions): Promise<UsageResult> {
    const hold = { hold_id: requireId(holdId, "Provide the id of the hold.") };
    const body = { amount: wholeNumber(amount, "amount", 0, Number.MAX_SAFE_INTEGER, SETTLED_AMOUNT) };
    return (await this.#usage("Usage.SettleHold", hold, body, options)).data;
  }

  async releaseUsage(holdId: string, options?: CallOptions): Promise<UsageResult> {
    const hold = { hold_id: requireId(holdId, "Provide the id of the hold.") };
    return (await this.#usage("Usage.ReleaseHold", hold, undefined, options)).data;
  }

  async startHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Hold> {
    const key = requiredKey(options?.idempotencyKey, 200 - EXCESS.length);
    const { data: answer, retried } = await this.#createHold(feature, amount, options);
    if (answer.outcome === "refused") throw new UsageRefusedError(answer);
    const open =
      answer.holdId !== null &&
      answer.expiresAt !== null &&
      (answer.outcome === "held" ||
        (answer.outcome === "duplicate" && answer.expiresAt.getTime() > answer.asOf.getTime()));
    if (!open) throw new UsageReplayedError(answer);
    return this.#hold(feature, key, answer, answer.outcome === "duplicate" && !retried, options.timeout);
  }

  #hold(
    feature: Feature<"metered">,
    key: string,
    answer: UsageResult,
    duplicate: boolean,
    timeout: number | undefined,
  ): Hold {
    const holdId = answer.holdId as string;
    let used: number | undefined;
    let first: Promise<UsageResult> | undefined;
    const call = (): CallOptions => (timeout === undefined ? {} : { timeout });
    const settle = async (): Promise<UsageResult> => {
      const total = used ?? answer.amount;
      const settled = Math.min(total, answer.amount);
      const excess = total > answer.amount ? total - answer.amount : undefined;
      const observe = (amount: number) =>
        this.recordUsage(feature, amount, {
          ...call(),
          mode: "observe",
          idempotencyKey: key + EXCESS,
          ...(answer.currency === null ? {} : { currency: answer.currency }),
        });
      let unrecorded = excess;
      let closed = false;
      try {
        let result: UsageResult;
        try {
          result = await this.settleUsage(holdId, settled, call());
          closed = true;
        } catch (error) {
          if (!(error instanceof ApiError && error.reason === "HOLD_EXPIRED")) throw error;
          closed = true;
          if (total === 0) return await release();
          unrecorded = total;
          return await observe(total);
        }
        if (excess !== undefined) await observe(excess);
        return result;
      } catch (cause) {
        throw new UsageSettlementError({
          holdId,
          settled: closed,
          amount: settled,
          excess: unrecorded,
          excessKey: key + EXCESS,
          result: undefined,
          cause,
        });
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
        this.#transport.report(error);
      }
    };
    return {
      id: holdId,
      amount: answer.amount,
      expiresAt: answer.expiresAt as Date,
      result: answer,
      duplicate,
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
    const heldAt = performance.now();
    const lifetime = hold.expiresAt.getTime() - hold.result.asOf.getTime();
    const signal = options.signal;
    const dispose = (hold as Hold & { [DISPOSE]: () => Promise<void> })[DISPOSE];
    let running: Promise<R> | undefined;
    let result: R;
    try {
      signal?.throwIfAborted();
      running = Promise.resolve(work({ hold, signal: signal ?? new AbortController().signal }));
      result = await untilAborted(running, signal);
    } catch (error) {
      if (hold.duplicate) throw error;
      if (running && signal?.aborted && Object.is(error, signal.reason)) {
        disposeOnceStopped(running, lifetime - (performance.now() - heldAt), dispose);
      } else {
        await dispose();
      }
      throw error;
    }
    if (hold.duplicate) return result;
    try {
      await hold.finish();
    } catch (error) {
      if (!(error instanceof UsageSettlementError)) throw error;
      throw new UsageSettlementError({
        holdId: error.holdId,
        settled: error.settled,
        amount: error.amount,
        excess: error.excess,
        excessKey: error.excessKey,
        result,
        cause: error.cause,
      });
    }
    return result;
  }

  async #send<T>(
    operation: Operation,
    body: Record<string, unknown> | undefined,
    decode: Decoder,
    options: CallOptions | undefined,
    retryable?: boolean,
    variables: Record<string, string> = {},
  ): Promise<T> {
    const answer = await this.#transport.send<T>({
      ...route(operation, { external_id: this.id, ...variables }),
      customer: this.id,
      body,
      ...(retryable === undefined ? {} : { retryable }),
      decode,
      options,
    });
    return answer.data;
  }

  register(options?: RegisterOptions): Promise<RegisteredCustomer> {
    const body = { ...details(options), ...(options?.visitor === undefined ? {} : { visitorId: options.visitor }) };
    return this.#send("Customers.RegisterCustomer", body, decodeRegistered, options);
  }

  details(options?: CallOptions): Promise<CustomerRecord> {
    return this.#send("Customers.GetCustomer", undefined, decodeCustomer, options);
  }

  update(options: UpdateOptions): Promise<CustomerRecord> {
    return this.#send("Customers.UpdateCustomer", details(options), decodeCustomer, options);
  }

  erase(options?: CallOptions): Promise<void> {
    return this.#send("Customers.EraseCustomer", {}, decodeNothing, options, true);
  }

  pricing(options?: CustomerPricingOptions): Promise<CustomerPricing> {
    return readPricing(
      this.#transport,
      "Pricing.GetCustomerPricing",
      { external_id: this.id },
      {},
      options,
      decodeCustomerPricing,
      this.id,
    );
  }

  async snapshot(options?: SnapshotOptions): Promise<Snapshot> {
    const body =
      options?.ttlSeconds === undefined
        ? {}
        : { lifetimeSeconds: wholeNumber(options.ttlSeconds, "ttlSeconds", 60, SNAPSHOT_SECONDS) };
    return this.#send("Snapshots.CreateSnapshot", body, decodeSnapshot, options, true);
  }

  async token(options?: TokenOptions): Promise<IssuedCustomerToken> {
    const body = {
      ...(options?.scopes === undefined ? {} : { scopes: options.scopes.map(scopeEnum) }),
      ...(options?.ttlSeconds === undefined
        ? {}
        : { lifetimeSeconds: wholeNumber(options.ttlSeconds, "ttlSeconds", 60, 3600) }),
    };
    return this.#send("CustomerTokens.CreateToken", body, decodeToken, options);
  }

  async grant(feature: Feature | string, options: GrantOptions): Promise<GrantResult> {
    const body = {
      featureKey: featureKey(feature),
      value: grantValue(options?.value),
      ...(options.days === undefined ? {} : { days: wholeNumber(options.days, "days", 1, 3650) }),
      ...revision(options),
      ...currency(options),
    };
    return this.#send("Grants.CreateGrant", body, decodeGrant, options);
  }

  async revokeGrant(grantId: string, options?: RevisionOptions): Promise<RevokedGrant> {
    const grant = { grant_id: requireId(grantId, "Provide the id of the grant.") };
    const retryable = options?.expectedRevision === undefined;
    return this.#send("Grants.RevokeGrant", revision(options), decodeRevokedGrant, options, retryable, grant);
  }

  async setTrack(trackId: string | null, options?: CallOptions): Promise<TrackAssignment> {
    const body =
      trackId === null ? {} : { trackId: requireId(trackId, "Pass the track's id, or null for the default track.") };
    return this.#send("CustomerTracks.AssignTrack", body, decodeTrack, options);
  }

  async adjustMeter(feature: Feature<"metered"> | string, options: AdjustMeterOptions): Promise<UsageResult> {
    const meter = { feature_key: featureKey(feature) };
    const idempotencyKey = options?.idempotencyKey === undefined ? undefined : requiredKey(options.idempotencyKey);
    const body = {
      ...adjustment(options),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...currency(options),
    };
    const retryable = idempotencyKey !== undefined;
    return (await this.#usage("Usage.AdjustMeter", meter, body, options, idempotencyKey, retryable)).data;
  }

  #move(
    operation: Operation,
    body: Record<string, unknown>,
    options: RevisionOptions | undefined,
    variables: Record<string, string> = {},
  ): Promise<MoveStep> {
    const retryable = operation !== "Subscriptions.ChooseSubscription" && options?.expectedRevision === undefined;
    return this.#send(operation, { ...body, ...revision(options) }, decodeMove, options, retryable, variables);
  }

  async subscribe(plan: string, options?: SubscribeOptions): Promise<MoveStep> {
    const offer = options?.offer;
    const body = {
      plan: { planKey: requireId(plan, "Name the plan by its key.") },
      ...(options?.period === undefined ? {} : { periodId: options.period }),
      ...(options?.quantity === undefined ? {} : { quantity: wholeNumber(options.quantity, "quantity", 1) }),
      ...(offer === undefined ? {} : { offer: "code" in offer ? { code: offer.code } : { offerKey: offer.key } }),
      ...(options?.returnUrl === undefined ? {} : { returnUrl: options.returnUrl }),
      ...flags(options, ["register"]),
      ...place(options),
    };
    return this.#move("Subscriptions.ChooseSubscription", body, options);
  }

  async cancel(options?: CancelOptions): Promise<MoveStep> {
    const body = {
      ...(options?.product === undefined ? {} : { productId: options.product }),
      ...(options?.endsAt === undefined ? {} : { endsAt: epochSeconds(options.endsAt, "endsAt") }),
    };
    return this.#move("Subscriptions.CancelSubscription", body, options);
  }

  async undoPendingChange(options?: ProductMoveOptions): Promise<MoveStep> {
    const body = options?.product === undefined ? {} : { productId: options.product };
    return this.#move("Subscriptions.CancelPendingChange", body, options);
  }

  setPlan(plan: string, options?: SetPlanOptions): Promise<MoveStep>;
  setPlan(plan: null, options: EndPlanOptions): Promise<MoveStep>;
  async setPlan(plan: string | null, options?: SetPlanOptions | EndPlanOptions): Promise<MoveStep> {
    if (plan === null) {
      const end = options as EndPlanOptions | undefined;
      const body = {
        end: { productId: requireId(end?.product, "Pass product: the id of the product whose plan ends.") },
        ...when(end?.when),
        ...flags(end, ["endBilling", "waiveExitCharges"]),
      };
      return this.#move("Subscriptions.SetPlan", body, end);
    }
    const move = options as SetPlanOptions | undefined;
    const body = {
      set: { planKey: requireId(plan, "Name the plan by its key, or pass null to end it.") },
      ...(move?.period === undefined ? {} : { periodId: move.period }),
      ...when(move?.when),
      ...(move?.until === undefined ? {} : { until: epochSeconds(move.until, "until") }),
      ...(move?.offers === undefined ? {} : { offers: move.offers.map(offerChoice) }),
      ...flags(move, ["latestVersion", "keepBilling", "endBilling", "waiveExitCharges", "register"]),
      ...place(move),
    };
    return this.#move("Subscriptions.SetPlan", body, move);
  }

  async setAddOn(addOn: string, options?: SetAddOnOptions): Promise<MoveStep> {
    const body = {
      ...(options?.quantity === undefined ? {} : { quantity: wholeNumber(options.quantity, "quantity", 1) }),
      ...(options?.replaces === undefined
        ? {}
        : { replaces: { planKey: requireId(options.replaces, "Name the replaced add-on by its key.") } }),
      ...flags(options, ["register"]),
    };
    return this.#move("Subscriptions.SetAddOn", body, options, this.#addOn(addOn));
  }

  async removeAddOn(addOn: string, options?: RevisionOptions): Promise<MoveStep> {
    return this.#move("Subscriptions.RemoveAddOn", {}, options, this.#addOn(addOn));
  }

  async undoAddOnChange(addOn: string, options?: RevisionOptions): Promise<MoveStep> {
    return this.#move("Subscriptions.CancelPendingAddOnChange", {}, options, this.#addOn(addOn));
  }

  plans(options?: CheckOptions): Promise<CustomerPlans> {
    return this.#cached<CustomerPlans>("Subscriptions.ListAvailablePlans", {}, options, decodePlans);
  }

  async billingPortal(options: BillingPortalOptions): Promise<{ readonly url: string }> {
    const returnUrl = requireId(
      options?.returnUrl,
      "Pass returnUrl: where the provider's page sends the customer back to.",
    );
    return this.#send("Billing.CreatePortalSession", { returnUrl }, decodePortal, options);
  }

  syncBilling(options?: CallOptions): Promise<{ readonly changed: boolean }> {
    return this.#send("Billing.SyncBilling", {}, decodeSync, options, true);
  }

  billing(options?: CallOptions): Promise<CustomerBilling> {
    return this.#send("Billing.GetBilling", undefined, decodeBilling, options);
  }

  #addOn(addOn: string): Record<string, string> {
    return { plan_key: requireId(addOn, "Name the add-on by its key.") };
  }

  async cancelUsage(usageId: string, options?: CancelUsageOptions): Promise<UsageResult> {
    const usage = { usage_id: requireId(usageId, "Provide the id of the usage report.") };
    const body = options?.reason === undefined ? {} : { reason: options.reason };
    return (await this.#usage("Usage.CancelReport", usage, body, options)).data;
  }
}
