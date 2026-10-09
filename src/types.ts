/**
 * A string-literal union that also accepts strings newer API releases add, so unknown values
 * type-check while editors still complete the known ones.
 */
export type Open<T extends string> = T | (string & {});

/** A feature's type: on/off, a setting, a meter, or a group of other features. */
export type FeatureType = Open<"boolean" | "config" | "metered" | "group">;

/** A feature's value: on (`true`), an amount (`0` included), or `"unlimited"`. */
export type Value = true | number | "unlimited";

/** An amount left on a meter, or `"unlimited"`. */
export type Limit = number | "unlimited";

/** The environment an answer comes from. */
export interface Environment {
  /** The environment's id. */
  readonly id: string;
  /** The environment's name. */
  readonly name: string;
  /** `test` or `live`. */
  readonly kind: Open<"test" | "live">;
}

/** An environment named by its id alone, as a snapshot names it. */
export interface EnvironmentRef {
  /** The environment's id. */
  readonly id: string;
}

/** A track, by id and name. */
export interface TrackRef {
  /** The track's id. */
  readonly id: string;
  /** The track's name. */
  readonly name: string;
}

/** The experiment and arm a caller is in. */
export interface Experiment {
  /** The experiment's id. */
  readonly id: string;
  /** The arm the caller is in. */
  readonly arm: Open<"control" | "variant">;
}

/** Where an answer comes from: the environment, the track, and the catalogue it serves. */
export interface AnswerContext {
  /** The environment the credential names. */
  readonly environment: Environment;
  /** The track the customer or caller resolved to. */
  readonly track: TrackRef;
  /** The release the answer comes from, or `null` when the track follows a change or runs nothing yet. */
  readonly release: number | null;
  /** The change the answer comes from, or `null`. */
  readonly change: string | null;
  /** True on a track for testers and in a test environment, where test money is taken. */
  readonly testers: boolean;
  /** The experiment and arm the caller is in, or `null`. */
  readonly experiment: Experiment | null;
}

/** A plan's share of a feature's value. */
export interface PlanSource {
  /** `plan`. */
  readonly type: "plan";
  /** The plan's key. */
  readonly plan: string;
  /** The plan's name. */
  readonly name: string;
  /** The plan version held. */
  readonly version: number;
  /** True when held because it is the default plan. */
  readonly byDefault: boolean;
  /** The plan's share of the value. */
  readonly value: Value;
}

/** An add-on's share of a feature's value. */
export interface AddOnSource {
  /** `addon`. */
  readonly type: "addon";
  /** The add-on's key. */
  readonly plan: string;
  /** The add-on's name. */
  readonly name: string;
  /** The add-on version held. */
  readonly version: number;
  /** How many are held. */
  readonly quantity: number;
  /** The add-on's share of the value. */
  readonly value: Value;
}

/** A grant's share of a feature's value. */
export interface GrantSource {
  /** `grant`. */
  readonly type: "grant";
  /** The grant's id. */
  readonly grant: string;
  /** When the grant ends, or `null`. */
  readonly until: Date | null;
  /** The grant's share of the value. */
  readonly value: Value;
}

/** Banked credits' share of a metered feature's value. */
export interface BankedSource {
  /** `banked`. */
  readonly type: "banked";
  /** The credits banked. */
  readonly value: number;
}

/** A group's members, which decide it. */
export interface GroupSource {
  /** `group`. */
  readonly type: "group";
  /** The member features' keys. */
  readonly features: readonly string[];
}

/** Where part of a feature's value comes from. */
export type EntitlementSource = PlanSource | AddOnSource | GrantSource | BankedSource | GroupSource;

/** A plan move that would give the customer a feature they lack. */
export interface Upgrade {
  /** The plan's key. */
  readonly plan: string;
  /** The plan's name. */
  readonly name: string;
  /** How the customer would move to it. */
  readonly move: Move;
  /** `buy` when the customer can make the move alone, `contact` for a sales-led move, or `unavailable`. */
  readonly action: MoveAction;
  /** Why the move is unavailable, a sentence for the developer, else `null`. */
  readonly reason: string | null;
}

/** How a customer would move to a plan or add-on. */
export type Move = Open<"subscribe" | "upgrade" | "downgrade" | "switch" | "add" | "replace">;

/**
 * Who can make a move: `buy`, the customer alone; `contact`, only the company, as a sales-led move;
 * `unavailable`, nobody now.
 */
export type MoveAction = Open<"buy" | "contact" | "unavailable">;

/** A store or payment provider that bills a plan. */
export type BilledBy = Open<"stripe" | "apple" | "google">;

/** A billing period: the stable `key` that writes take, and the `label` to display. */
export interface Period {
  /** The period's key, such as `monthly`, which stays the same when its label changes. */
  readonly key: string;
  /** The period's label, such as `Monthly`: display copy. */
  readonly label: string;
}

/** Whether a write's answer replays an earlier call's. */
export interface Replayed {
  /** True when the API answered a repeated idempotency key with the first call's answer, so this call changed nothing. */
  readonly replayed: boolean;
}

/** The fields every check shares, whatever the feature's type. */
export interface CheckBase extends AnswerContext {
  /** The customer's external id. */
  readonly customer: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** The feature's key. */
  readonly feature: string;
  /** The feature's type. */
  readonly type: FeatureType;
  /** Entitler's decision: whether the customer may use the feature now. */
  readonly entitled: boolean;
  /** The customer's value: on, an amount, or unlimited; `0` when nothing gives it. */
  readonly value: Value;
  /** Where the value comes from. */
  readonly sources: readonly EntitlementSource[];
  /** How much was used, for a metered feature. */
  readonly used?: number;
  /** How much open holds reserve, for a metered feature. */
  readonly held?: number;
  /** How much is left, for a metered feature. */
  readonly remaining?: Limit;
  /** When the meter starts again, for a metered feature. */
  readonly resetsAt?: Date | null;
  /** Plan moves that would give the customer the feature. */
  readonly upgrades: readonly Upgrade[];
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;
}

/** A check of an on/off feature or a group: on (`true`) or off (`0`). */
export interface SwitchCheck extends CheckBase {
  /** `boolean` or `group`. */
  readonly type: "boolean" | "group";
  /** `true` when on, `0` when off. */
  readonly value: true | 0;
}

/** A check of a setting: an amount, or unlimited. */
export interface ConfigCheck extends CheckBase {
  /** `config`. */
  readonly type: "config";
  /** The setting's amount, or `"unlimited"`; `true` when the plan only turns it on. */
  readonly value: Value;
}

/** A check of a metered feature, with its meter. */
export interface MeteredCheck extends CheckBase {
  /** `metered`. */
  readonly type: "metered";
  /** The allowance, or `"unlimited"`. */
  readonly value: Limit;
  /** How much the customer used this period or window. */
  readonly used: number;
  /** How much open holds reserve; counted in `remaining`. */
  readonly held: number;
  /** How much is left, or `"unlimited"`. */
  readonly remaining: Limit;
  /** When the meter starts again, or `null`. */
  readonly resetsAt: Date | null;
}

/**
 * The answer to `check(feature)`, typed by the feature's type when the feature is a
 * {@link Feature} constant: `Check<"metered">` carries the meter, `Check<"boolean">` is on or off.
 */
export type Check<T extends FeatureType = FeatureType> = [T] extends ["metered"]
  ? MeteredCheck
  : [T] extends ["boolean"]
    ? SwitchCheck
    : [T] extends ["group"]
      ? SwitchCheck
      : [T] extends ["config"]
        ? ConfigCheck
        : CheckBase;

/** One feature in a customer's entitlement list. */
export interface Entitlement {
  /** The feature's key. */
  readonly key: string;
  /** The feature's type. */
  readonly type: FeatureType;
  /** Entitler's decision: whether the customer may use the feature now. */
  readonly entitled: boolean;
  /** The customer's value; for a group, `true` or `0`. */
  readonly value: Value;
  /** Where the value comes from; a group names its member features. */
  readonly sources: readonly EntitlementSource[];
  /** How much was used, for a metered feature. */
  readonly used?: number;
  /** How much open holds reserve, for a metered feature. */
  readonly held?: number;
  /** How much is left, for a metered feature. */
  readonly remaining?: Limit;
  /** When the meter starts again, for a metered feature. */
  readonly resetsAt?: Date | null;
}

/** A plan by id, key and name. */
export interface PlanSummary {
  /** The plan's public id. */
  readonly id: string;
  /** The plan's key. */
  readonly key: string;
  /** The plan's name. */
  readonly name: string;
}

/** A plan or an add-on, by id, key, name and kind. */
export interface PlanInfo extends PlanSummary {
  /** `plan` or `addon`. */
  readonly kind: Open<"plan" | "addon">;
}

/** A product, by key and name. */
export interface ProductSummary {
  /** The product's key. */
  readonly key: string;
  /** The product's name. */
  readonly name: string;
}

/** A price on a payment provider. */
export interface ProviderPrice {
  /** The amount in the currency's smallest unit. */
  readonly amount: number;
  /** The ISO 4217 currency code. */
  readonly currency: string;
  /** How often it charges, or `null` for a one-time price. */
  readonly interval: Open<"day" | "week" | "month" | "year"> | null;
  /** How many intervals between charges. */
  readonly intervalCount: number;
  /** Whether tax is included. */
  readonly tax: Open<"inclusive" | "exclusive" | "unspecified">;
}

/** A SKU the customer can buy: a period of a plan on one store or payment provider. */
export interface OfferedSku {
  /** The billing period. */
  readonly period: Period;
  /** `stripe`, `apple` or `google`. */
  readonly connector: BilledBy;
  /** The provider's ids for it. */
  readonly ids: Readonly<Record<string, string>>;
  /** The provider's price, when known. */
  readonly price?: ProviderPrice | null;
}

/** A SKU the customer bought, named by its connector and the provider's ids. */
export interface Sku {
  /** `stripe`, `apple` or `google`. */
  readonly connector: BilledBy;
  /** The provider's ids, such as `{ priceId: "price_123" }`. */
  readonly ids: Readonly<Record<string, string>>;
}

/** What a move would change for the customer. */
export interface Impact {
  /** `gains`, `loses`, `changes` or `same`. */
  readonly kind: Open<"gains" | "loses" | "changes" | "same">;
  /** The change, in words. */
  readonly text: string;
}

/** A plan the customer holds. */
export interface HeldPlan {
  /** The plan. */
  readonly plan: PlanInfo;
  /** Its product, or `null`. */
  readonly product: ProductSummary | null;
  /** The plan version held, or `null`. */
  readonly version: number | null;
  /** True when held because it is the default plan. */
  readonly byDefault: boolean;
  /** The billing period, or `null` when Entitler sets none. */
  readonly period: Period | null;
  /** When it renews, or `null`. */
  readonly renewsAt: Date | null;
  /** The change booked for `renewsAt`, or `null`. */
  readonly pending: PendingPlanChange | null;
  /** Who bills it, or `null` when nothing does. The store's own page manages `apple` and `google`; the billing portal manages `stripe`. */
  readonly billedBy: BilledBy | null;
}

/** A change booked for a held plan's renewal: a move to another plan, or a cancel. */
export type PendingPlanChange =
  | {
      /** A move to another plan. */
      readonly type: "move";
      /** The plan it moves to. */
      readonly plan: PlanInfo;
    }
  | {
      /** A cancel. */
      readonly type: "cancel";
      /** The default plan the cancel leads to, or `null`. */
      readonly movingTo: PlanInfo | null;
    };

/** A plan or add-on the customer could move to. */
export interface OptionPlan extends PlanInfo {
  /** Its description. */
  readonly description: string;
  /** True for the default plan. */
  readonly default: boolean;
}

/** A plan the customer could move to. */
export interface MoveOption {
  /** The plan. */
  readonly plan: OptionPlan;
  /** Its product, or `null`. */
  readonly product: ProductSummary | null;
  /** The plan it moves from, or `null`. */
  readonly from: PlanSummary | null;
  /** How the customer would move to it. */
  readonly move: Move;
  /** `buy` decides a buy button, `contact` a contact-sales link, `unavailable` neither. */
  readonly action: MoveAction;
  /** Why the move is unavailable, a sentence for the developer, else `null`. */
  readonly reason: string | null;
  /** When the move takes effect. */
  readonly when: Open<"now" | "end">;
  /** The billing periods it is sold in. */
  readonly periods: readonly Period[];
  /** What the move changes. */
  readonly impact: readonly Impact[];
  /** The SKUs that sell it. */
  readonly skus: readonly OfferedSku[];
}

/** The customer's plans: the plans they hold and the plans they can move to. */
export interface CustomerPlans extends AnswerContext {
  /** The customer's external id. */
  readonly customer: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** The plans held. */
  readonly held: readonly HeldPlan[];
  /** The plans the customer can move to. */
  readonly options: readonly MoveOption[];
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;
}

/** A billing period of a plan. */
export interface BillingPeriod extends Period {
  /** How many units. */
  readonly count: number;
  /** The unit. */
  readonly unit: Open<"days" | "weeks" | "months">;
}

/** A payment channel: a provider connection. */
export interface Channel {
  /** The provider. */
  readonly provider: Open<"stripe" | "apple" | "google">;
  /** The connection's id. */
  readonly connectionId: string;
}

/** A period of a plan as one channel lists it. */
export interface ChannelListing {
  /** The channel. */
  readonly channel: Channel;
  /** The channel's name. */
  readonly name: string;
  /** `live` or `test` money, or `null`. */
  readonly mode: Open<"live" | "test"> | null;
  /** True when the customer can buy it there now. */
  readonly purchasable: boolean;
  /** The provider's ids, or `null`. */
  readonly ids: Readonly<Record<string, string>> | null;
  /** The provider's price, when known. */
  readonly price?: ProviderPrice | null;
}

/** A period of a plan, as listed on each channel. */
export interface PeriodListing {
  /** The billing period. */
  readonly period: Period;
  /** Each channel's listing. */
  readonly channels: readonly ChannelListing[];
}

/** A product on sale. */
export interface PublishedProduct {
  /** The product's key. */
  readonly key: string;
  /** The product's name. */
  readonly name: string;
  /** The product's default plan, or `null`. */
  readonly defaultPlan: string | null;
}

/** A plan on a pricing page. */
export interface PricingPlan {
  /** The plan's public id. */
  readonly id: string;
  /** The plan's key. */
  readonly key: string;
  /** The plan's name. */
  readonly name: string;
  /** The plan's description. */
  readonly description: string;
  /** `plan` or `addon`. */
  readonly kind: Open<"plan" | "addon">;
  /** Its product's key, or `null`. */
  readonly product: string | null;
  /** True when the plan is sold by the vendor's sales team. */
  readonly salesLed: boolean;
  /** `active` or `legacy`. */
  readonly status: Open<"active" | "legacy">;
  /** The plan version on sale, or `null`. */
  readonly version: number | null;
  /** True for the default plan. */
  readonly default: boolean;
  /** Its billing periods. */
  readonly periods: readonly BillingPeriod[];
  /** The plans an add-on attaches to. */
  readonly attachesTo: readonly string[];
  /** Each feature's value on the plan. */
  readonly features: Readonly<Record<string, Value>>;
  /** Each period's provider listings. */
  readonly listings: readonly PeriodListing[];
}

/** The pricing on sale, signed out or for one customer. Always computed now, so it has no `asOf`. */
export interface Pricing extends AnswerContext {
  /** The customer's external id, or `null` signed out. */
  readonly customer: string | null;
  /** The default plan's key, or `null`. */
  readonly defaultPlan: string | null;
  /** The products on sale. */
  readonly products: readonly PublishedProduct[];
  /** The plans on sale. */
  readonly plans: readonly PricingPlan[];
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;
}

/** How often a meter starts again. */
export interface MeterWindow {
  /** How many units. */
  readonly count: number;
  /** The unit. */
  readonly unit: Open<"hours" | "days" | "weeks" | "months">;
  /** Whether windows start with the customer's period or on the calendar. */
  readonly anchor?: Open<"period" | "calendar">;
}

/** A feature in the catalogue. */
export interface FeatureListing {
  /** The feature's id. */
  readonly id: string;
  /** The feature's key. */
  readonly key: string;
  /** The feature's name. */
  readonly name: string;
  /** The feature's type. */
  readonly type: FeatureType;
  /** The feature's description. */
  readonly description: string;
  /** The unit a metered feature or a setting counts in, or `""`. */
  readonly unit: string;
  /** How often a metered feature starts again, or `null` to follow the billing period. */
  readonly resetEvery: MeterWindow | null;
  /** True when archived. */
  readonly archived: boolean;
  /** A group's direct members. */
  readonly includes: readonly string[];
}

/** The catalogue's features, with the release or change they were read from. */
export interface FeatureList {
  /** The environment. */
  readonly environment: Environment;
  /** The track read. */
  readonly track: TrackRef;
  /** The release read, or `null`. */
  readonly release: number | null;
  /** The change read, or `null`. */
  readonly change: string | null;
  /** The features. */
  readonly features: readonly FeatureListing[];
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;
}

/** Who or what reported usage. */
export type UsageSource = Open<"api" | "client" | "dashboard">;

/** One entry in the usage log. */
export interface UsageEvent {
  /** The usage report's id. */
  readonly id: string;
  /** The feature's key. */
  readonly feature: string;
  /** The amount. */
  readonly amount: number;
  /** `use`, or `adjust` for a meter set. */
  readonly kind: Open<"use" | "adjust">;
  /** What a meter set set the meter to, or `null`. */
  readonly setTo: number | null;
  /** Who reported it. */
  readonly source: UsageSource;
  /** The person who reported it, or `null`. */
  readonly actor: string | null;
  /** When it happened. */
  readonly at: Date;
  /** When it was cancelled, or `null`. */
  readonly cancelledAt: Date | null;
}

/** One page of a paged list. */
export interface Page<T> {
  /** The page's items. */
  readonly items: readonly T[];
  /** The cursor of the next page, or `null` on the last page. */
  readonly next: string | null;
}

/**
 * Every item of a paged list, fetched a page at a time as iteration reaches it.
 *
 * @example
 * ```ts
 * for await (const customer of server.customers.list({ q: "acme" })) console.log(customer.name);
 * ```
 */
export interface Paged<T> extends AsyncIterable<T> {
  /** Each page in turn, for showing a page at a time. */
  pages(): AsyncIterable<Page<T>>;
}

/**
 * A usage log: its first page (`items`, `next`), and every item across pages with `for await`,
 * each later page fetched only when iteration reaches it.
 */
export interface UsageLog extends Page<UsageEvent>, Paged<UsageEvent> {}

/** A metered feature's meter in the customer's usage. */
export interface FeatureUsage {
  /** The feature's key. */
  readonly feature: string;
  /** The feature's type. */
  readonly type: FeatureType;
  /** Entitler's decision: whether the customer may use the feature now. */
  readonly entitled: boolean;
  /** The allowance, or `0`. */
  readonly value: Value;
  /** Where the allowance comes from. */
  readonly sources: readonly EntitlementSource[];
  /** How much was used. */
  readonly used: number;
  /** How much open holds reserve. */
  readonly held: number;
  /** How much is left, `"unlimited"`, or `null`. */
  readonly remaining: Limit | null;
  /** When the meter starts again, or `null`. */
  readonly resetsAt: Date | null;
}

/** The customer's meters and usage log. */
export interface CustomerUsage extends AnswerContext {
  /** The customer's external id. */
  readonly customer: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** When the first meter starts again, or `null`. */
  readonly metersStartAgainAt: Date | null;
  /** Each metered feature's meter. */
  readonly features: readonly FeatureUsage[];
  /** The usage log: its first page, and every item across pages, fetched as iteration reaches them. */
  readonly log: UsageLog;
}

/** How a usage report counts against the allowance. */
export type UsageMode = Open<"gate" | "observe">;

/** What a usage write did. */
export type UsageOutcome = Open<
  "recorded" | "duplicate" | "refused" | "held" | "settled" | "released" | "cancelled" | "adjusted"
>;

/** The answer to a usage write: the check fields, then what the write did. */
export interface UsageResult extends AnswerContext, Replayed {
  /** The customer's external id. */
  readonly customer: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** The feature's key. */
  readonly feature: string;
  /** The feature's type. */
  readonly type: FeatureType;
  /** Entitler's decision after the write. */
  readonly entitled: boolean;
  /** The allowance. */
  readonly value: Value;
  /** Where the allowance comes from. */
  readonly sources: readonly EntitlementSource[];
  /** How much was used after the write. */
  readonly used?: number;
  /** How much open holds reserve after the write. */
  readonly held?: number;
  /** How much is left after the write. */
  readonly remaining?: Limit;
  /** When the meter starts again. */
  readonly resetsAt?: Date | null;
  /** Plan moves that would give more allowance. */
  readonly upgrades: readonly Upgrade[];
  /** What happened. */
  readonly outcome: UsageOutcome;
  /** Why a gated report or a hold was refused, else `null`. */
  readonly refusal: Open<"not_entitled" | "over_allowance"> | null;
  /** The usage report this created, repeated, settled or cancelled, or `null`. */
  readonly id: string | null;
  /** The hold this created, settled, released or repeated, or `null`. */
  readonly holdId: string | null;
  /** The report's mode. */
  readonly mode: UsageMode;
  /** The amount asked for, or the original's on a replay. */
  readonly amount: number;
  /** How much this request moved the meter. */
  readonly meterChange: number;
  /** How far `used` is past the allowance after the write; `0` within it. */
  readonly overBy: number;
  /** True when the report's period had closed when it arrived. */
  readonly late: boolean;
  /** When the usage happened, or `null`. */
  readonly occurredAt: Date | null;
  /** When the hold expires, or `null` for a report. */
  readonly expiresAt: Date | null;
  /** Who reported it. */
  readonly reportedAs: UsageSource;
}

/** One event of a usage batch, always recorded in `observe` mode. */
export interface UsageEventInput {
  /** The customer's external id. */
  readonly customer: string;
  /** The metered feature. */
  readonly feature: Feature<"metered">;
  /** The amount, a whole number from 1. */
  readonly amount: number;
  /** When the usage happened. */
  readonly occurredAt?: Date | string;
  /** A key naming the event in your own system, such as a message or job id. Required. */
  readonly idempotencyKey: string;
}

/** Why one batch event failed. */
export interface UsageEventError {
  /** The error code. */
  readonly code: string;
  /** The error message. */
  readonly message: string;
}

/** What one batch event did. */
export interface UsageEventResult {
  /** The event's position in the input. */
  readonly index: number;
  /** `recorded`, `duplicate` or `error`. */
  readonly outcome: Open<"recorded" | "duplicate" | "error">;
  /** The usage report's id, or `null`. */
  readonly id: string | null;
  /** True when the event's period had closed when it arrived. */
  readonly late: boolean;
  /** Why the event failed, or `null`. */
  readonly error: UsageEventError | null;
  /** The idempotency key the event was sent with, or `null` when it had none. */
  readonly idempotencyKey: string | null;
  /** True when the event's request replayed an earlier one with the same events. */
  readonly replayed: boolean;
}

/** The answer to a usage batch: one result per event, in input order, and the totals. */
export interface UsageBatchResult {
  /** One result per event. */
  readonly results: readonly UsageEventResult[];
  /** How many events were recorded. */
  readonly recorded: number;
  /** How many were replays. */
  readonly duplicates: number;
  /** How many failed. */
  readonly errors: number;
}

/** A customer that a register call created or found. */
export interface RegisteredCustomer extends Replayed {
  /** Entitler's id for the customer. */
  readonly id: string;
  /** The customer's external id. */
  readonly externalId: string;
  /** The environment's id. */
  readonly environmentId: string;
  /** When the customer was registered. */
  readonly createdAt: Date;
  /** True when this call registered them. */
  readonly created: boolean;
}

/** A plan held, with its version. */
export interface VersionedPlan extends PlanSummary {
  /** The plan version held. */
  readonly version: number;
}

/** A plan held in one product. */
export interface ProductPlan extends VersionedPlan {
  /** The product's key. */
  readonly product: string;
}

/** What a customer is: on a recurring plan, a one-time plan, changing, on the default, or none. */
export type CustomerKind = Open<"recurring" | "one_time" | "changing" | "default" | "none">;

/** A customer in a list. */
export interface CustomerSummary {
  /** Entitler's id for the customer. */
  readonly id: string;
  /** The customer's external id. */
  readonly externalId: string;
  /** The customer's name. */
  readonly name: string;
  /** The customer's email. */
  readonly email: string;
  /** The environment's id. */
  readonly environmentId: string;
  /** True for a sample customer. */
  readonly sample: boolean;
  /** When the customer was registered. */
  readonly createdAt: Date;
  /** The main plan held, or `null`. */
  readonly plan: VersionedPlan | null;
  /** Every plan held, one per product. */
  readonly plans: readonly ProductPlan[];
  /** The default plan, or `null`. */
  readonly defaultPlan: PlanSummary | null;
  /** The subscription's status. */
  readonly status: string;
  /** What kind of customer they are. */
  readonly kind: CustomerKind;
  /** The vendor's metadata. */
  readonly metadata: Readonly<Record<string, string>>;
  /** The customer's track. */
  readonly track: TrackRef;
  /** True for a test customer. */
  readonly testCustomer: boolean;
}

/** How a purchase was made. */
export interface Purchase {
  /** `real` or `test` money. */
  readonly money: Open<"real" | "test">;
  /** The channel, or `null`. */
  readonly channel: Channel | null;
  /** The release it was bought from, or `null`. */
  readonly release: number | null;
  /** The change it was bought from, or `null`. */
  readonly change: string | null;
  /** The experiment arm, or `null`. */
  readonly arm: Open<"control" | "variant"> | null;
}

/** An add-on the customer holds. */
export interface HeldAddOn {
  /** The add-on. */
  readonly plan: PlanSummary;
  /** The version held. */
  readonly version: number;
  /** How many. */
  readonly quantity: number;
  /** True when it can be held more than once. */
  readonly countable: boolean;
  /** When it was added. */
  readonly addedAt: Date;
  /** The add-on it is changing to, or `null`. */
  readonly movingTo: PlanSummary | null;
  /** How it was bought. */
  readonly purchase: Purchase;
}

/** The provider's billing period. */
export interface ProviderPeriod {
  /** The provider. */
  readonly provider: Open<"stripe">;
  /** When the period started. */
  readonly startsAt: Date;
  /** When it ends. */
  readonly endsAt: Date;
  /** When the trial ends, or `null`. */
  readonly trialEndsAt: Date | null;
  /** When it cancels, or `null`. */
  readonly cancelsAt: Date | null;
}

/** A plan held in Entitler apart from the plan the payment provider bills. */
export interface PlanOverride {
  /** The plan the provider bills. */
  readonly from: PlanSummary;
  /** Its period. */
  readonly period: string;
  /** The channel that bills it, or `null`. */
  readonly billedBy: Channel | null;
  /** When the override started. */
  readonly since: Date;
  /** Who made it. */
  readonly by: string;
}

/** A move to another plan, booked for the period's end. */
export interface PendingMove {
  /** `move`. */
  readonly type: "move";
  /** The plan the customer moves to. */
  readonly plan: PlanSummary;
}

/** A cancellation, booked for the period's end. */
export interface PendingCancel {
  /** `cancel`. */
  readonly type: "cancel";
  /** The plan the customer falls back to, or `null`. */
  readonly movingTo: PlanSummary | null;
}

/** A subscription. */
export interface Subscription {
  /** Its product. */
  readonly product: ProductSummary;
  /** The plan. */
  readonly plan: PlanSummary;
  /** The version held. */
  readonly version: number;
  /** The cohort, or `null`. */
  readonly cohort: number | null;
  /** The billing period's key. */
  readonly period: string;
  /** When it started. */
  readonly startedAt: Date;
  /** When it renews. */
  readonly renewsAt: Date;
  /** The provider's billing period, or `null`. */
  readonly billing: ProviderPeriod | null;
  /** The add-ons held. */
  readonly addOns: readonly HeldAddOn[];
  /** A change booked for the period's end, or `null`. */
  readonly pending: PendingMove | PendingCancel | null;
  /** How it was bought. */
  readonly purchase: Purchase;
  /** A plan held apart from the plan billed, or `null`. */
  readonly override: PlanOverride | null;
}

/** A grant: a feature given to the customer for a while. */
export interface Grant {
  /** The grant's id. */
  readonly id: string;
  /** The feature's key. */
  readonly feature: string;
  /** The value granted. */
  readonly value: string;
  /** When it starts. */
  readonly from: Date;
  /** When it ends, or `null`. */
  readonly until: Date | null;
  /** When it was revoked, or `null`. */
  readonly revokedAt: Date | null;
  /** Why it was granted. */
  readonly reason: string;
  /** Who granted it. */
  readonly by: string;
  /** The person or system that decided, or `null`. */
  readonly actor: string | null;
}

/** A product, with the customer's subscription to it. */
export interface ProductHolding {
  /** The product. */
  readonly product: ProductSummary;
  /** Its default plan, or `null`. */
  readonly defaultPlan: PlanSummary | null;
  /** The customer's subscription, or `null`. */
  readonly subscription: Subscription | null;
}

/** An entry in a customer's activity. */
export interface Activity {
  /** What happened, in words. */
  readonly text: string;
  /** When it happened. */
  readonly at: Date;
}

/** A customer's details: plans, add-ons, grants, entitlements and usage log. */
export interface CustomerDetails {
  /** The customer. */
  readonly customer: CustomerSummary;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** The main subscription, or `null`. */
  readonly subscription: Subscription | null;
  /** The default plan, or `null`. */
  readonly defaultPlan: PlanSummary | null;
  /** Each product's plan. */
  readonly products: readonly ProductHolding[];
  /** The add-ons held. */
  readonly addOns: readonly HeldAddOn[];
  /** The entitlements. */
  readonly entitlements: readonly Entitlement[];
  /** Banked credits by feature. */
  readonly banked: Readonly<Record<string, number>>;
  /** The moves open to the customer. */
  readonly moveOptions: readonly MoveOption[];
  /** The grants. */
  readonly grants: readonly Grant[];
  /** The usage log: its first page, and every item across pages, fetched as iteration reaches them. */
  readonly usage: UsageLog;
  /** Recent activity. */
  readonly activity: readonly Activity[];
  /** The environment. */
  readonly environment: Environment;
}

/** The customer's track after `setTrack`. */
export interface CustomerTrack extends Replayed {
  /** The customer's external id. */
  readonly customer: string;
  /** The track. */
  readonly track: TrackRef;
  /** Who placed the customer on it, or `null`. */
  readonly source: Open<"server" | "dashboard" | "store_sandbox"> | null;
  /** The previous track's id, or `null`. */
  readonly previousTrackId: string | null;
}

/** The scopes a customer token can hold. */
export type CustomerTokenScope = Open<"entitlements:read" | "usage:read" | "usage:write" | "billing:self">;

/** A customer token minted by the server, for an in-app client. */
export interface IssuedCustomerToken {
  /** The token. Treat it as a secret of that customer's session. */
  readonly token: string;
  /** The customer's external id. */
  readonly customer: string;
  /** Its scopes. */
  readonly scopes: readonly CustomerTokenScope[];
  /** When it expires. */
  readonly expiresAt: Date;
}

/** A signed entitlements snapshot, to keep and verify offline. */
export interface IssuedSnapshot {
  /** The snapshot token. */
  readonly token: string;
  /** When it stops verifying. */
  readonly expiresAt: Date;
  /** The id of the key that signed it. */
  readonly keyId: string;
}

/** A public key that verifies snapshots. */
export interface SnapshotKey {
  /** `EC`. */
  readonly kty: "EC";
  /** `P-256`. */
  readonly crv: "P-256";
  /** The x coordinate, base64url. */
  readonly x: string;
  /** The y coordinate, base64url. */
  readonly y: string;
  /** The key's id. */
  readonly kid: string;
  /** `ES256`. */
  readonly alg: "ES256";
  /** `sig`. */
  readonly use: "sig";
}

/** The key set that verifies snapshots. */
export interface SnapshotKeys {
  /** The keys. */
  readonly keys: readonly SnapshotKey[];
}

/** Every scope the SDK knows, in the order `scopes()` answers them. */
export type Scope =
  | "plans:read"
  | "entitlements:read"
  | "usage:read"
  | "usage:write"
  | "billing:self"
  | "customers:register"
  | "customers:read"
  | "customers:write"
  | "customers:profile"
  | "customers:sample"
  | "tokens:mint"
  | "plans:write"
  | "plans:release"
  | "tracks:manage"
  | "tracks:promote"
  | "tracks:assign"
  | "keys:manage"
  | "members:manage"
  | "projects:manage"
  | "org:manage";

/** The scopes a client's credential holds. */
export interface Scopes {
  /** The scopes the SDK knows, in a fixed order. */
  readonly scopes: readonly Scope[];
  /** For an identity client: whether the sign-in provider lets a new person register. */
  readonly registration?: boolean;
}

/** A subscription's status on the payment provider. */
export type ProviderStatus = Open<
  "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused"
>;

/** A difference between the plan billed and the plan held. */
export interface BillingDrift {
  /** The plan billed. */
  readonly billedPlan: string;
  /** The plan held, or `null`. */
  readonly heldPlan: string | null;
  /** When it was seen. */
  readonly observedAt: Date;
}

/** One product's billing on the payment provider. */
export interface ProductBilling {
  /** The product's key, or `null`. */
  readonly product: string | null;
  /** The subscription's status, or `null`. */
  readonly status: ProviderStatus | null;
  /** The SKU billed, or `null`. */
  readonly sku: OfferedSku | null;
  /** How many items are billed. */
  readonly items: number;
  /** A difference between billed and held, or `null`. */
  readonly drift: BillingDrift | null;
}

/** The customer's billing on the payment provider. */
export interface CustomerBilling {
  /** The provider, or `null`. */
  readonly provider: Open<"stripe"> | null;
  /** The subscription's status, or `null`. */
  readonly status: ProviderStatus | null;
  /** The SKU billed, or `null`. */
  readonly sku: OfferedSku | null;
  /** How many items are billed. */
  readonly items: number;
  /** A difference between billed and held, or `null`. */
  readonly drift: BillingDrift | null;
  /** Each product's billing. */
  readonly products?: readonly ProductBilling[];
}

/** A page on the payment provider: a checkout or the billing portal. */
export interface ProviderPage {
  /** The provider. */
  readonly provider: Open<"stripe">;
  /** The page's URL, to send the customer to. */
  readonly url: string;
}

/** A plan change: the plan or add-on it leaves the customer on, and when it takes effect. */
export interface PlanChange extends Replayed {
  /** The product, or `null`. */
  readonly product: ProductSummary | null;
  /** The plan or add-on the change leaves the customer on, or `null` when they are left with no plan in that product. */
  readonly plan: PlanInfo | null;
  /** An add-on's quantity after the change, `0` when it is removed, or `null` for a plan. */
  readonly quantity: number | null;
  /** `now`, or `renewal` when it takes effect at the period's end. */
  readonly effective: Open<"now" | "renewal">;
  /** When it takes effect. */
  readonly at: Date;
  /** When the plan ends unless renewed, from `setPlan`'s `until`, or `null`. */
  readonly until: Date | null;
  /** False when nothing changed: a cancel with nothing to cancel, an undo with nothing pending, a plan already held. */
  readonly changed: boolean;
}

/** `subscribe`'s step when the change is made: the {@link PlanChange} fields. */
export interface SubscribeDone extends PlanChange {
  /** `done`. */
  readonly next: "done";
}

/** `subscribe`'s step when the customer pays first: send them to `url`. The plan changes once they pay. */
export interface SubscribePay {
  /** `pay`. */
  readonly next: "pay";
  /** The provider's page: Stripe Checkout, or a confirmation such as 3-D Secure. */
  readonly url: string;
}

/** `subscribe`'s step while the provider confirms a payment (a bank debit): show the change as pending. */
export interface SubscribeConfirming {
  /** `confirming`. */
  readonly next: "confirming";
}

/** `subscribe`'s step when a store bills the product, so the customer changes it there. */
export interface SubscribeManage {
  /** `manage`. */
  readonly next: "manage";
  /** `apple` or `google`. */
  readonly billedBy: BilledBy;
}

/** A step this SDK does not know yet, kept with its raw answer. */
export interface SubscribeUnknown {
  /** `unknown`. */
  readonly next: "unknown";
  /** The step's name as the API sent it. */
  readonly raw: string;
}

/** The next step after `subscribe`, by `next`: `done`, `pay`, `confirming`, `manage`, or `unknown`. */
export type SubscribeStep = SubscribeDone | SubscribePay | SubscribeConfirming | SubscribeManage | SubscribeUnknown;

/** The answer to `syncBilling()`. */
export interface BillingSync {
  /** True when the provider's state moved the customer. */
  readonly changed: boolean;
}

/** A grant made or revoked. */
export interface GrantChange extends Replayed {
  /** The grant, so a support tool keeps its id. */
  readonly grant: Grant;
}

/** A gap a rollout would leave, from `409 listing_gaps`. */
export interface ListingGap {
  /** `stops_selling` or `unlisted`. */
  readonly kind: Open<"stops_selling" | "unlisted">;
  /** The plan's key. */
  readonly plan: string;
  /** The listing key. */
  readonly key: string;
  /** The period. */
  readonly period: string;
  /** The channel, or `null`. */
  readonly channel: Channel | null;
}

/** A listing whose provider price fails the checks, from `409 listing_invalid`. */
export interface ListingProblem {
  /** The channel. */
  readonly channel: Channel;
  /** The plan's key. */
  readonly plan: string;
  /** The period. */
  readonly period: string;
  /** The provider's ids. */
  readonly ids: Readonly<Record<string, string>>;
  /** What is wrong. */
  readonly problem: Open<"price_not_found" | "price_inactive" | "interval_mismatch">;
}

/**
 * A feature constant: its key, its type and, for a group, its leaf members. Declare one with
 * {@link defineFeature}, or generate them all with `npx entitler generate`.
 */
export interface Feature<T extends FeatureType = FeatureType> {
  /** The feature's key. */
  readonly key: string;
  /** The feature's type. */
  readonly type: T;
  /** A group's leaf member keys, for documentation; empty for other features. */
  readonly includes: readonly string[];
}

/**
 * Declares a feature constant by hand, for apps that do not use the generator.
 *
 * @example
 * ```ts
 * const exportPdf = defineFeature("export_pdf", "boolean");
 * const check = await customer.check(exportPdf); // a Check<"boolean">
 * ```
 */
export function defineFeature<const T extends FeatureType>(
  key: string,
  type: T,
  includes: readonly string[] = [],
): Feature<T> {
  return Object.freeze({ key, type, includes: Object.freeze([...includes]) });
}
