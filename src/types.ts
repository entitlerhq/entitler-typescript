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
  /** The customer's value; for an on/off feature or a group, `true` or `0`. */
  readonly value: Value;
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
  /** True when this call registered the customer, false when they were registered already. */
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
  /** Entitler's id for the customer. */
  readonly customerId: string;
  /** What the token lets the client do. */
  readonly scopes: readonly CustomerTokenScope[];
  /** When the token expires. */
  readonly expiresAt: Date;
}
