/**
 * A string-literal union that also accepts strings newer API releases add, so unknown values
 * type-check while editors still complete the known ones.
 */
export type Open<T extends string> = T | (string & {});

/** A feature's type: on/off, a setting, a meter, or a group of other features. */
export type FeatureType = Open<"switch" | "configuration" | "metered" | "group">;

/** A feature's value: on (`true`), an amount (`0` for off or none), or `"unlimited"`. */
export type Value = true | number | "unlimited";

/** An amount, or `"unlimited"`. */
export type Limit = number | "unlimited";

/** A money value's limit in each market, by market id. */
export type Markets = Readonly<Record<string, Limit | undefined>>;

/** A release answered. */
export interface ServedRelease {
  /** `release`. */
  readonly type: "release";
  /** The release's id. */
  readonly id: string;
  /** The release's number. */
  readonly number: number;
}

/** The track the customer is on. */
export interface ServedTrack {
  /** The track's id. */
  readonly id: string;
  /** The track's name. */
  readonly name: string;
}

/** The unreleased change whose catalogue answered, for a track that follows a change. */
export interface ServedChange {
  /** `change`. */
  readonly type: "change";
  /** The change's id. */
  readonly id: string;
}

/** No catalogue answered: nothing is released yet. */
export interface ServedNothing {
  /** `nothing`. */
  readonly type: "nothing";
}

/** The catalogue an answer comes from: the customer's track, and the release or change it serves. */
export interface Served {
  /** The track the customer is on, or `null` when the answer names none. */
  readonly track: ServedTrack | null;
  /** The release or unreleased change that answered, or nothing yet. */
  readonly source: ServedRelease | ServedChange | ServedNothing;
}

/** Where an answer comes from, and for whom. */
export interface AnswerContext {
  /** The customer's external id: the id your app uses for them. */
  readonly customer: string;
  /** Entitler's id for the customer, or `null` before they are registered. */
  readonly customerId: string | null;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** When the answer next changes on its own, such as a grant ending, or `null`. */
  readonly nextChangeAt: Date | null;
  /** The catalogue the answer comes from. */
  readonly served: Served;
}

/** A plan's share of a feature's value. */
export interface PlanSource {
  /** `plan`. */
  readonly type: "plan";
  /** The plan's id. */
  readonly planId: string;
  /** The plan's key. */
  readonly plan: string;
  /** The plan's name. */
  readonly name: string;
  /** The product's id, or `null` when the answer names none. */
  readonly product: string | null;
  /** The plan version held. */
  readonly version: number;
  /** True when held because it is the product's default plan. */
  readonly byDefault: boolean;
  /** The plan's share of the value, or `null` when the answer names none. */
  readonly value: Value | null;
  /** A money value's limit in each market, by market id, or `null` for a value that isn't money. */
  readonly markets: Markets | null;
  /** The group whose membership passed this value on, or `null`. */
  readonly through: string | null;
}

/** An add-on's share of a feature's value. */
export interface AddOnSource {
  /** `addon`. */
  readonly type: "addon";
  /** The add-on's id. */
  readonly planId: string;
  /** The add-on's key. */
  readonly plan: string;
  /** The add-on's name. */
  readonly name: string;
  /** The add-on version held. */
  readonly version: number;
  /** How many are held. */
  readonly quantity: number;
  /** The add-on's share of the value, or `null` when the answer names none. */
  readonly value: Value | null;
  /** A money value's limit in each market, by market id, or `null` for a value that isn't money. */
  readonly markets: Markets | null;
  /** The group whose membership passed this value on, or `null`. */
  readonly through: string | null;
}

/** A grant's share of a feature's value. */
export interface GrantSource {
  /** `grant`. */
  readonly type: "grant";
  /** The grant's id. */
  readonly grant: string;
  /** When the grant ends, or `null`. */
  readonly until: Date | null;
  /** The grant's share of the value, or `null` when the answer names none. */
  readonly value: Value | null;
  /** A money value's limit in each market, by market id, or `null` for a value that isn't money. */
  readonly markets: Markets | null;
  /** The group whose membership passed this value on, or `null`. */
  readonly through: string | null;
}

/** A group's members, which decide it. */
export interface GroupSource {
  /** `group`. */
  readonly type: "group";
  /** The member features' keys. */
  readonly features: readonly string[];
}

/** Where part of a feature's value comes from. */
export type EntitlementSource = PlanSource | AddOnSource | GrantSource | GroupSource;

/** How a customer would move to a plan or add-on. */
export type Move = Open<"subscribe" | "upgrade" | "switch" | "add" | "replace">;

/** Who can make a move: `buy`, the customer alone; `contact`, only the company, as a sales-led move. */
export type MoveAction = Open<"buy" | "contact">;

/** A plan or add-on that would give the customer a feature they lack. */
export interface Upgrade {
  /** `plan` or `add_on`. */
  readonly kind: Open<"plan" | "add_on">;
  /** The plan's id. */
  readonly planId: string;
  /** The plan's key. */
  readonly plan: string;
  /** The plan's name. */
  readonly name: string;
  /** The product's id, or `null` when the answer names none. */
  readonly product: string | null;
  /** How the customer would move to it. */
  readonly move: Move;
  /** Who can make the move. */
  readonly action: MoveAction;
}

/** A metered feature's meter. */
export interface Meter {
  /** How much the customer used this period or window. */
  readonly used: number;
  /** How much open holds reserve; counted in `remaining`. */
  readonly held: number;
  /** Credits banked from earlier periods. */
  readonly banked: number;
  /** How much is left, or `"unlimited"`. */
  readonly remaining: Limit;
  /** When the meter starts again, or `null`. */
  readonly resetsAt: Date | null;
}

/** One feature's entitlement: Entitler's decision, the value and where it comes from. */
export interface Entitlement {
  /** The feature's key. */
  readonly key: string;
  /** The feature's type. */
  readonly type: FeatureType;
  /** Entitler's decision: whether the customer may use the feature now. */
  readonly entitled: boolean;
  /** The customer's value; for an on/off feature or a group, `true` or `0`, and `0` for money. */
  readonly value: Value;
  /** A money value's limit in each market, by market id, or `null` for a value that isn't money. */
  readonly markets: Markets | null;
  /**
   * How many decimal places the feature's amounts count: every amount on it (the allowance, the
   * meter, usage) is a whole number of its smallest unit, so 1.5 GB at 3 decimals is 1500.
   */
  readonly decimals: number;
  /** The lower-case currency code a money feature counts in, or `null` for any other feature. */
  readonly currency: string | null;
  /** Where the value comes from; a group names its member features. */
  readonly sources: readonly EntitlementSource[];
  /** Plans and add-ons that would give the customer the feature. */
  readonly upgrades: readonly Upgrade[];
  /** The meter, for a metered feature; `null` otherwise. */
  readonly meter: Meter | null;
}

/** The fields every check shares, whatever the feature's type. */
export interface CheckBase extends AnswerContext, Entitlement {
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;
}

/** A check of an on/off feature or a group: on (`true`) or off (`0`). */
export interface SwitchCheck extends CheckBase {
  /** `switch` or `group`. */
  readonly type: "switch" | "group";
  /** `true` when on, `0` when off. */
  readonly value: true | 0;
  /** `null`. */
  readonly meter: null;
}

/** A check of a setting: an amount, or unlimited. */
export interface ConfigurationCheck extends CheckBase {
  /** `configuration`. */
  readonly type: "configuration";
  /** The setting's amount, or `"unlimited"`. */
  readonly value: Limit;
  /** `null`. */
  readonly meter: null;
}

/** A check of a metered feature, with its meter. */
export interface MeteredCheck extends CheckBase {
  /** `metered`. */
  readonly type: "metered";
  /** The allowance, or `"unlimited"`. */
  readonly value: Limit;
  /** The meter. */
  readonly meter: Meter;
}

/**
 * The answer to `check(feature)`, typed by the feature's type when the feature is a
 * {@link Feature} constant: `Check<"metered">` carries the meter, `Check<"switch">` is on or off.
 */
export type Check<T extends FeatureType = FeatureType> = [T] extends ["metered"]
  ? MeteredCheck
  : [T] extends ["switch"]
    ? SwitchCheck
    : [T] extends ["group"]
      ? SwitchCheck
      : [T] extends ["configuration"]
        ? ConfigurationCheck
        : CheckBase;

/** A feature constant: its key and its type. Declare one with {@link defineFeature}. */
export interface Feature<T extends FeatureType = FeatureType> {
  /** The feature's key. */
  readonly key: string;
  /** The feature's type. */
  readonly type: T;
}

/**
 * Declares a feature constant, so `check` answers the type the feature has.
 *
 * @example
 * ```ts
 * const aiCredits = defineFeature("ai_credits", "metered");
 * const check = await customer.check(aiCredits); // a Check<"metered">, with its meter
 * ```
 */
export function defineFeature<const T extends FeatureType>(key: string, type: T): Feature<T> {
  return Object.freeze({ key, type });
}

/** How a usage report counts against the allowance: `gate` refuses what doesn't fit, `observe` records it all. */
export type UsageMode = Open<"gate" | "observe">;

/** What a usage write did. */
export type UsageOutcome = Open<
  "recorded" | "refused" | "duplicate" | "cancelled" | "held" | "settled" | "released" | "adjusted"
>;

/** Why a gated report or a hold was refused. */
export type UsageRefusal = Open<"not_entitled" | "over_allowance">;

/** The answer to a usage write: the feature's entitlement after it, and what the write did. */
export interface UsageResult extends AnswerContext, Entitlement {
  /** What happened. */
  readonly outcome: UsageOutcome;
  /** Why a gated report or a hold was refused, else `null`. */
  readonly refusal: UsageRefusal | null;
  /** The usage report this created, repeated or settled, or `null`. */
  readonly id: string | null;
  /** The hold this created, settled, released or repeated, or `null`. */
  readonly holdId: string | null;
  /** The report's mode. */
  readonly mode: UsageMode;
  /** The amount asked for, or the first request's on a replay. */
  readonly amount: number;
  /** How much this request moved the meter. */
  readonly meterChange: number;
  /** How far use is past the allowance after the write; `0` within it. */
  readonly overBy: number;
  /** True when the report's period had closed when it arrived, so it moved no meter. */
  readonly late: boolean;
  /** When the usage happened, or `null`. */
  readonly occurredAt: Date | null;
  /** When the hold expires, or `null` for a report. */
  readonly expiresAt: Date | null;
  /** True when the idempotency key repeated an earlier request, which answered this. */
  readonly replayed: boolean;
  /** True when the write would have taken the meter past 2^53 − 1, so it was recorded off the meter. */
  readonly saturated: boolean;
}

/** A customer as Entitler keeps them. */
export interface CustomerRecord {
  /** The customer's external id: the id your app uses for them. */
  readonly customer: string;
  /** Entitler's id for the customer. */
  readonly customerId: string;
  /** The customer's name, or `null`. */
  readonly name: string | null;
  /** The customer's email, or `null`. */
  readonly email: string | null;
  /** Your own attributes for the customer, such as their region or account manager. */
  readonly attributes: Readonly<Record<string, string>>;
  /** The id of the track the customer is on, or `null` for the default track. */
  readonly trackId: string | null;
  /** `real` for a customer who pays real money, `test` for one in test mode. */
  readonly money: Open<"real" | "test">;
  /** The record's revision, which every change raises. */
  readonly revision: number;
  /** When the customer was registered. */
  readonly createdAt: Date;
  /** When the record last changed. */
  readonly updatedAt: Date;
}

/** The answer to `register()`: the customer, and whether this call registered them. */
export interface RegisteredCustomer extends CustomerRecord {
  /**
   * True when this call registered the customer, false when they were registered already. Also false
   * when a lost answer was retried, so a sign-up count read from it can be one short.
   */
  readonly created: boolean;
}

/** What a customer token lets an in-app client do. */
export type CustomerTokenScope = Open<"entitlements:read" | "usage:read" | "usage:write" | "billing:self">;

/** A customer token minted by the server, for an in-app client. */
export interface IssuedCustomerToken {
  /** The token. Treat it as a secret of that customer's session. */
  readonly token: string;
  /** The token's id. */
  readonly id: string;
  /** Entitler's id for the customer, or `null` while they are not registered. */
  readonly customerId: string | null;
  /** What the token lets the client do. */
  readonly scopes: readonly CustomerTokenScope[];
  /** When the token expires. */
  readonly expiresAt: Date;
}

/** A snapshot Entitler signed of a customer's entitlements, to check them offline with `verifySnapshot`. */
export interface Snapshot {
  /** The signed snapshot, a compact JWS. Store it in the app's own storage. */
  readonly token: string;
  /** The id of the key that signed it. */
  readonly keyId: string;
  /** When it stops verifying. */
  readonly expiresAt: Date;
}

/** A public key that verifies snapshots, as a JSON Web Key. */
export interface SnapshotKey {
  /** `EC`. */
  readonly kty: "EC";
  /** `P-256`. */
  readonly crv: "P-256";
  /** `ES256`. */
  readonly alg: "ES256";
  /** `sig`. */
  readonly use: "sig";
  /** The key's id, which a snapshot's header names. */
  readonly kid: string;
  /** The key's x coordinate, base64url. */
  readonly x: string;
  /** The key's y coordinate, base64url. */
  readonly y: string;
}

/** The keys that verify snapshots, as a JSON Web Key Set. Persist it as it is. */
export interface SnapshotKeySet {
  /** The keys. */
  readonly keys: readonly SnapshotKey[];
}

/** An amount of money: a whole number of the currency's minor unit, and how to show it. */
export interface Amount {
  /** The amount in the currency's minor unit, such as cents. */
  readonly amount: number;
  /** The lower-case currency code. */
  readonly currency: string;
  /** The amount formatted for the request's locale, such as `$12.00`. */
  readonly display: string;
}

/** The market prices are in. */
export interface PricingMarket {
  /** The market's id. */
  readonly id: string;
  /** The market's key. */
  readonly key: string;
  /** The market's name. */
  readonly name: string;
  /** The lower-case currency code its prices are in. */
  readonly currency: string;
  /** Whether its prices include tax or have it added. */
  readonly tax: Open<"included" | "added">;
}

/** A product on sale. */
export interface PricedProduct {
  /** The product's id. */
  readonly id: string;
  /** The product's key. */
  readonly key: string;
  /** The product's name. */
  readonly name: string;
  /** The plan a customer holds by default, or `null`. */
  readonly defaultPlanId: string | null;
}

/** A billing period a plan is sold for. */
export interface PricedPeriod {
  /** The period's id. */
  readonly id: string;
  /** The period's key, such as `monthly`. */
  readonly key: string;
  /** The period's label, such as `Monthly`. */
  readonly label: string;
  /** How many units it lasts. */
  readonly count: number;
  /** Its unit. */
  readonly unit: Open<"days" | "weeks" | "months">;
}

/** One band of a tiered or per-unit price. */
export interface PricedBand {
  /** The quantity the band runs up to, or `null` for the last band. */
  readonly upTo: number | null;
  /** True when the amount is per unit, false when it is for the whole band. */
  readonly perUnit: boolean;
  /** The band's amount, or `null`. */
  readonly amount: Amount | null;
}

/** A plan's price for one period. */
export interface PeriodPrice {
  /** The period's id, or `null` for a price with no period. */
  readonly period: string | null;
  /** The price, or `null` when the plan is not priced in the market. */
  readonly price: Amount | null;
  /** The bands of a price that depends on quantity; empty otherwise. */
  readonly bands: readonly PricedBand[];
}

/** When a fee is charged. */
export type FeeSchedule =
  | { readonly type: "on_purchase" }
  | { readonly type: "every_months"; readonly months: number; readonly firstAfterMonths: number }
  | { readonly type: "yearly"; readonly dates: readonly { readonly month: number; readonly day: number }[] };

/** A fee a plan charges or credits beside its price. */
export interface PricedFee {
  /** The fee's key. */
  readonly key: string;
  /** The fee's name. */
  readonly name: string;
  /** `debit` charges the customer, `credit` pays them. */
  readonly direction: Open<"debit" | "credit">;
  /** The fee's amount, or `null`. */
  readonly price: Amount | null;
  /** When it is charged, or `null`. */
  readonly schedule: FeeSchedule | null;
}

/** A feature a plan gives. */
export interface PlanItem {
  /** The feature's key. */
  readonly feature: string;
  /** The value the plan gives; `true` for an on/off feature or a group, and `0` for money. */
  readonly value: Value;
  /** A money value's limit in each market, by market id, or `null` for a value that isn't money. */
  readonly markets: Markets | null;
  /** How much unused allowance carries over, or `null`. */
  readonly bank: Limit | null;
  /** The benefit a group member's share counts for, in thousandths, or `null`. */
  readonly benefitThousandths: number | null;
}

/** A store's price for a listing. */
export interface ListingPrice {
  /** The amount in the currency's minor unit. */
  readonly amount: number;
  /** The lower-case currency code. */
  readonly currency: string;
  /** How often it renews. */
  readonly interval: Open<"day" | "week" | "month" | "year">;
  /** How many intervals each renewal spans. */
  readonly intervalCount: number;
  /** Whether the price includes tax. */
  readonly tax: Open<"inclusive" | "exclusive">;
}

/** A store or payment provider a plan is listed in. */
export interface PricedChannel {
  /** The payment provider. */
  readonly provider: Open<"stripe" | "apple" | "google">;
  /** The connection's id. */
  readonly connectionId: string;
  /** The connection's name. */
  readonly name: string;
  /** `live` or `test`. */
  readonly mode: Open<"live" | "test">;
  /** True when the customer can buy it there now. */
  readonly purchasable: boolean;
  /** The provider's ids for the listing, as the provider names them, such as `productId` or `priceId`. */
  readonly ids: Readonly<Record<string, string>>;
  /** The provider's price, or `null`. */
  readonly price: ListingPrice | null;
}

/** Where a plan is listed for one period. */
export interface PlanListing {
  /** The period's id, or `null`. */
  readonly period: string | null;
  /** The stores and payment providers it is listed in. */
  readonly channels: readonly PricedChannel[];
}

/** A plan or add-on on sale, with its prices in the sheet's market. */
export interface PricedPlan {
  /** The plan's id. */
  readonly id: string;
  /** The plan's key. */
  readonly key: string;
  /** The plan's name. */
  readonly name: string;
  /** The plan's description. */
  readonly description: string;
  /** `plan` or `add_on`. */
  readonly kind: Open<"plan" | "add_on">;
  /** The product's id, or `null`. */
  readonly product: string | null;
  /** The plan version on sale. */
  readonly version: number;
  /** True for the product's default plan. */
  readonly byDefault: boolean;
  /** `active`, `legacy` or `archived`. */
  readonly status: Open<"active" | "legacy" | "archived">;
  /** True when only the company sells it. */
  readonly salesLed: boolean;
  /** `free`, `priced`, or `not_priced` in the sheet's market. */
  readonly priceState: Open<"free" | "priced" | "not_priced">;
  /** The trial a new subscriber gets, or `null`. */
  readonly trial: { readonly days: number; readonly months: number } | null;
  /** How many a customer may hold, or `null` when it has no quantity. */
  readonly quantity: { readonly min: number; readonly max: number | null } | null;
  /** The periods it is sold for. */
  readonly periods: readonly PricedPeriod[];
  /** Its price for each period. */
  readonly prices: readonly PeriodPrice[];
  /** Its fees. */
  readonly fees: readonly PricedFee[];
  /** The features it gives. */
  readonly items: readonly PlanItem[];
  /** The plans it can be added to, for an add-on. */
  readonly availableOn: readonly string[];
  /** Where it is listed for sale. */
  readonly listings: readonly PlanListing[];
}

/** The plans on sale and their prices. */
export interface PricingSheet {
  /** The market prices are in, or `null` when none was asked for. */
  readonly market: PricingMarket | null;
  /** The products on sale. */
  readonly products: readonly PricedProduct[];
  /** The plans and add-ons on sale. */
  readonly plans: readonly PricedPlan[];
  /** The catalogue the sheet comes from. */
  readonly served: Served;
  /** True when the sheet is a track for testers'. */
  readonly testers: boolean;
  /** The customer's external id for a customer's sheet, else `null`. */
  readonly customer: string | null;
}

/** An offer's discount on a price line. */
export interface LineDiscount {
  /** The offer's id. */
  readonly offerId: string;
  /** The offer's key. */
  readonly offerKey: string;
  /** The offer's name. */
  readonly offerName: string;
  /** The discount, or `null`. */
  readonly amount: Amount | null;
}

/** One plan's line on a customer's subscription. */
export interface PriceLine {
  /** The plan's id. */
  readonly planId: string;
  /** The plan version held. */
  readonly version: number;
  /** The period's id, or `null`. */
  readonly period: string | null;
  /** How many are held. */
  readonly quantity: number;
  /** `free`, `priced` or `not_priced`. */
  readonly state: Open<"free" | "priced" | "not_priced">;
  /** What the customer pays for the line, discounts taken off, or `null`. */
  readonly price: Amount | null;
  /** The price of one, or `null`. */
  readonly unitPrice: Amount | null;
  /** The price before discounts, or `null`. */
  readonly listPrice: Amount | null;
  /** The discounts taken off. */
  readonly discounts: readonly LineDiscount[];
}

/** A charge or credit a subscription will make. */
export interface NextCharge {
  /** The fee's key. */
  readonly fee: string;
  /** `debit` or `credit`. */
  readonly direction: Open<"debit" | "credit">;
  /** When it happens. */
  readonly at: Date;
  /** The amount, or `null`. */
  readonly amount: Amount | null;
}

/** What a customer pays for one subscription. */
export interface SubscriptionPrice {
  /** The subscription's id. */
  readonly subscriptionId: string;
  /** The product's id, or `null`. */
  readonly product: string | null;
  /** When it next renews. */
  readonly renewsAt: Date;
  /** The lines it charges now. */
  readonly now: readonly PriceLine[];
  /** The lines it will charge at renewal, or `null` when nothing changes. */
  readonly atRenewal: readonly PriceLine[] | null;
  /** The charges and credits coming. */
  readonly nextCharges: readonly NextCharge[];
}

/** A customer's pricing: the plans on sale to them, and what they pay now. */
export interface CustomerPricing extends PricingSheet {
  /** What the customer pays for each subscription, or `null` when Entitler has no prices for them. */
  readonly prices: {
    /** The customer's market, or `null`. */
    readonly market: PricingMarket | null;
    /** Each subscription's prices. */
    readonly subscriptions: readonly SubscriptionPrice[];
  } | null;
}
