import type {
  AnswerContext,
  Check,
  CustomerRecord,
  Entitlement,
  EntitlementSource,
  FeatureType,
  IssuedCustomerToken,
  Limit,
  Meter,
  RegisteredCustomer,
  Served,
  Snapshot,
  SnapshotKey,
  SnapshotKeySet,
  Upgrade,
  UsageResult,
  Value,
} from "./types.js";
import type * as Wire from "./wire.gen.js";

/** Checks an answer and answers it decoded, throwing `TypeError` when it does not fit. @internal */
export type Decoder = (value: unknown) => unknown;

class Mismatch extends TypeError {
  readonly path: readonly (string | number)[];

  constructor(path: readonly (string | number)[] = []) {
    const at = path.length === 0 ? "" : ` at ${path.join(".")}`;
    super(`The answer lacks a required field, or holds one of another type${at}.`);
    this.path = path;
  }
}

function fail(): never {
  throw new Mismatch();
}

function at<T>(step: string | number, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof Mismatch) throw new Mismatch([step, ...error.path]);
    throw error;
  }
}

function object<T>(value: unknown): T {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : fail();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : fail();
}

function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}

function whole(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail();
}

function list<T>(value: unknown, decode: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map((item, index) => at(index, () => decode(item))) : fail();
}

function seconds(value: unknown): Date {
  const date = new Date(whole(value) * 1000);
  return Number.isNaN(date.getTime()) ? fail() : date;
}

function optionalSeconds(value: unknown): Date | null {
  return value === undefined ? null : seconds(value);
}

function optionalMilliseconds(value: unknown): Date | null {
  return value === undefined ? null : new Date(whole(value));
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) ? (value as number) : fail();
}

function optionalText(value: unknown): string | null {
  return value === undefined ? null : text(value);
}

const NAMES: Record<string, string> = {
  ENTITLED_FEATURE_KIND_SWITCH: "switch",
  ENTITLED_FEATURE_KIND_METERED: "metered",
  ENTITLED_FEATURE_KIND_CONFIGURATION: "configuration",
  ENTITLED_FEATURE_KIND_GROUP: "group",
};

function enumName(value: unknown, prefix: string): string {
  const name = text(value);
  return NAMES[name] ?? (name.startsWith(prefix) ? name.slice(prefix.length).toLowerCase() : name);
}

function limit(value: unknown): Limit {
  const given = object<Wire.Limit>(value);
  return given.unlimited !== undefined ? "unlimited" : at("count", () => whole(given.count ?? 0));
}

function featureValue(value: unknown, entitled: boolean): Value {
  if (value === undefined) return 0;
  const given = object<Wire.FeatureValue>(value);
  if (given.switch !== undefined) return given.switch === true ? true : 0;
  if (given.metered !== undefined) return at("metered", () => limit(given.metered));
  if (given.configuration !== undefined) return at("configuration", () => limit(given.configuration));
  if (given.group !== undefined) return entitled ? true : 0;
  return 0;
}

function sourceValue(value: unknown): Value | null {
  return value === undefined ? null : featureValue(value, true);
}

function source(value: unknown): EntitlementSource | null {
  const given = object<Wire.EntitlementSource>(value);
  const through = (key: unknown) => (key === undefined || key === "" ? null : text(key));
  if (given.plan || given.defaultPlan) {
    const plan = object<Wire.PlanSource>(given.plan ?? given.defaultPlan);
    return at(given.plan ? "plan" : "defaultPlan", () => ({
      type: "plan" as const,
      planId: at("planId", () => text(plan.planId)),
      plan: at("planKey", () => text(plan.planKey)),
      name: at("planName", () => text(plan.planName)),
      product: at("productId", () => optionalText(plan.productId)),
      version: at("versionNumber", () => whole(plan.versionNumber)),
      byDefault: given.plan === undefined,
      value: at("value", () => sourceValue(plan.value)),
      through: at("throughFeatureKey", () => through(plan.throughFeatureKey)),
    }));
  }
  if (given.addOn) {
    const addOn = object<Wire.AddOnSource>(given.addOn);
    return at("addOn", () => ({
      type: "addon" as const,
      planId: at("planId", () => text(addOn.planId)),
      plan: at("planKey", () => text(addOn.planKey)),
      name: at("planName", () => text(addOn.planName)),
      version: at("versionNumber", () => whole(addOn.versionNumber)),
      quantity: at("quantity", () => whole(addOn.quantity)),
      value: at("value", () => sourceValue(addOn.value)),
      through: at("throughFeatureKey", () => through(addOn.throughFeatureKey)),
    }));
  }
  if (given.grant) {
    const grant = object<Wire.GrantSource>(given.grant);
    return at("grant", () => ({
      type: "grant" as const,
      grant: at("grantId", () => text(grant.grantId)),
      until: at("until", () => optionalSeconds(grant.until)),
      value: at("value", () => sourceValue(grant.value)),
      through: at("throughFeatureKey", () => through(grant.throughFeatureKey)),
    }));
  }
  if (given.group) {
    const group = object<Wire.GroupSource>(given.group);
    return at("group", () => ({
      type: "group" as const,
      features: at("featureKeys", () => list(group.featureKeys, text)),
    }));
  }
  return null;
}

function upgrade(value: unknown): Upgrade {
  const given = object<Wire.Upgrade>(value);
  return {
    kind: at("kind", () => enumName(given.kind, "UPGRADE_KIND_")),
    planId: at("planId", () => text(given.planId)),
    plan: at("planKey", () => text(given.planKey)),
    name: at("planName", () => text(given.planName)),
    product: at("productId", () => optionalText(given.productId)),
    move: at("move", () => enumName(given.move, "UPGRADE_MOVE_")),
    action: at("action", () => enumName(given.action, "UPGRADE_ACTION_")),
  };
}

function meter(value: unknown): Meter {
  const given = object<Wire.Meter>(value);
  return {
    used: at("used", () => whole(given.used)),
    held: at("held", () => whole(given.held)),
    banked: at("banked", () => whole(given.banked)),
    remaining: at("remaining", () => limit(given.remaining ?? { count: 0 })),
    resetsAt: at("resetsAt", () => optionalSeconds(given.resetsAt)),
  };
}

function entitlement(value: unknown): Entitlement {
  const given = object<Wire.Entitlement>(value);
  const entitled = at("entitled", () => bool(given.entitled));
  const type: FeatureType = at("kind", () => enumName(given.kind, "ENTITLED_FEATURE_KIND_"));
  return {
    key: at("featureKey", () => text(given.featureKey)),
    type,
    entitled,
    value: at("value", () => featureValue(given.value, entitled)),
    sources: at("sources", () =>
      list(given.sources, source).filter((known): known is EntitlementSource => known !== null),
    ),
    upgrades: at("upgrades", () => list(given.upgrades, upgrade)),
    meter: at("meter", () =>
      given.meter === undefined
        ? type === "metered"
          ? meter({ used: 0, held: 0, banked: 0 })
          : null
        : meter(given.meter),
    ),
  };
}

function served(value: unknown): Served {
  const given = object<Wire.ServedCatalogue>(value);
  const track = given.track === undefined ? null : object<Wire.ServedTrack>(given.track);
  return {
    track:
      track && at("track", () => ({ id: at("id", () => text(track.id)), name: at("name", () => text(track.name)) })),
    source: given.release
      ? at("release", () => {
          const release = object<Wire.ServedRelease>(given.release);
          return {
            type: "release" as const,
            id: at("id", () => text(release.id)),
            number: at("number", () => whole(release.number)),
          };
        })
      : given.changeId !== undefined
        ? { type: "change", id: at("changeId", () => text(given.changeId)) }
        : { type: "nothing" },
  };
}

function context(given: Wire.CheckFeatureResponse | Wire.ListEntitlementsResponse | Wire.TrackedUsage): AnswerContext {
  const customer = at("customer", () => object<Wire.EntitledCustomer>(given.customer));
  return {
    customer: at("customer", () => at("externalId", () => text(customer.externalId))),
    customerId: at("customer", () => at("customerId", () => optionalText(customer.customerId))),
    asOf: at("asOf", () => seconds(given.asOf)),
    nextChangeAt: "nextChangeAt" in given ? at("nextChangeAt", () => optionalSeconds(given.nextChangeAt)) : null,
    served: at("served", () => served(given.served ?? {})),
  };
}

/** Decodes `Entitlements.CheckFeature`'s answer. @internal */
export const decodeCheck: Decoder = (value) => {
  const given = object<Wire.CheckFeatureResponse>(value);
  return { ...context(given), ...at("entitlement", () => entitlement(given.entitlement)) } satisfies Omit<
    Check,
    "stale"
  >;
};

/** Decodes `Entitlements.ListEntitlements`' answer. @internal */
export const decodeEntitlements: Decoder = (value) => {
  const given = object<Wire.ListEntitlementsResponse>(value);
  return { ...context(given), entitlements: at("entitlements", () => list(given.entitlements, entitlement)) };
};

/** Decodes the answer every usage write shares, `{ tracked }`. @internal */
export const decodeUsage: Decoder = (value) => {
  const tracked = at("tracked", () => object<Wire.TrackedUsage>(object<Wire.ReportUsageResponse>(value).tracked));
  return at("tracked", () => {
    const usage = at("usage", () => object<Wire.UsageResult>(tracked.usage));
    return {
      ...context(tracked),
      ...at("entitlement", () => entitlement(tracked.entitlement)),
      ...at("usage", () => ({
        outcome: at("outcome", () => enumName(usage.outcome, "USAGE_OUTCOME_")),
        refusal: at("refusal", () => (usage.refusal === undefined ? null : enumName(usage.refusal, "USAGE_REFUSAL_"))),
        id: at("usageId", () => optionalText(usage.usageId)),
        holdId: at("holdId", () => optionalText(usage.holdId)),
        mode: at("mode", () => enumName(usage.mode, "USAGE_MODE_")),
        amount: at("amount", () => whole(usage.amount)),
        meterChange: at("meterChange", () => integer(usage.meterChange)),
        overBy: at("overBy", () => whole(usage.overBy)),
        late: at("late", () => bool(usage.late)),
        occurredAt: at("occurredAtMs", () => optionalMilliseconds(usage.occurredAtMs)),
        expiresAt: at("expiresAtMs", () => optionalMilliseconds(usage.expiresAtMs)),
        replayed: at("replayed", () => bool(usage.replayed)),
      })),
    } satisfies UsageResult;
  });
};

function customerRecord(value: unknown): CustomerRecord {
  const given = object<Wire.Customer>(value);
  return {
    customer: at("externalId", () => text(given.externalId)),
    customerId: at("id", () => text(given.id)),
    name: at("name", () => optionalText(given.name)),
    email: at("email", () => optionalText(given.email)),
    attributes: at("attributes", () =>
      Object.fromEntries(
        list(given.attributes, (item) => {
          const attribute = object<Wire.CustomerAttribute>(item);
          return [at("key", () => text(attribute.key)), at("value", () => text(attribute.value))];
        }),
      ),
    ),
    trackId: at("trackId", () => optionalText(given.trackId)),
    money: at("money", () => enumName(given.money, "CUSTOMER_MONEY_")),
    revision: at("revision", () => whole(given.revision)),
    createdAt: at("createdAt", () => seconds(given.createdAt)),
    updatedAt: at("updatedAt", () => seconds(given.updatedAt)),
  };
}

/** Decodes `Customers.GetCustomer`'s and `Customers.UpdateCustomer`'s answer. @internal */
export const decodeCustomer: Decoder = (value) =>
  at("customer", () => customerRecord(object<Wire.GetCustomerResponse>(value).customer));

/** Decodes `Customers.RegisterCustomer`'s answer. @internal */
export const decodeRegistered: Decoder = (value) => {
  const given = object<Wire.RegisterCustomerResponse>(value);
  return {
    ...at("customer", () => customerRecord(given.customer)),
    created: at("created", () => bool(given.created)),
  } satisfies RegisteredCustomer;
};

/** Decodes `CustomerTokens.CreateToken`'s answer. @internal */
export const decodeToken: Decoder = (value) => {
  const given = object<Wire.CreateTokenResponse>(value);
  return {
    token: at("token", () => text(given.token)),
    id: at("tokenId", () => text(given.tokenId)),
    customerId: at("customerId", () => optionalText(given.customerId)),
    scopes: at("scopes", () => list(given.scopes, scopeName)),
    expiresAt: at("expiresAt", () => seconds(given.expiresAt)),
  } satisfies IssuedCustomerToken;
};

/** Decodes an answer the SDK has no use for. @internal */
export const decodeNothing: Decoder = (value) => {
  object(value);
  return undefined;
};

/** A customer token scope as the API names it, such as `CUSTOMER_TOKEN_SCOPE_USAGE_WRITE`. @internal */
export function scopeEnum(scope: string): string {
  return `CUSTOMER_TOKEN_SCOPE_${scope.toUpperCase().replace(":", "_")}`;
}

function scopeName(value: unknown): string {
  const name = enumName(value, "CUSTOMER_TOKEN_SCOPE_");
  const split = name.lastIndexOf("_");
  return split < 0 ? name : `${name.slice(0, split)}:${name.slice(split + 1)}`;
}

/** Decodes `Snapshots.CreateSnapshot`'s answer. @internal */
export const decodeSnapshot: Decoder = (value) => {
  const given = object<Wire.CreateSnapshotResponse>(value);
  return {
    token: at("token", () => text(given.token)),
    keyId: at("keyId", () => text(given.keyId)),
    expiresAt: at("expiresAt", () => seconds(given.expiresAt)),
  } satisfies Snapshot;
};

function snapshotKey(value: unknown): SnapshotKey | null {
  const given = object<Record<string, unknown>>(value);
  if (given.kty !== "EC" || given.crv !== "P-256" || given.alg !== "ES256" || given.use !== "sig") return null;
  return {
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    use: "sig",
    kid: at("kid", () => text(given.kid)),
    x: at("x", () => text(given.x)),
    y: at("y", () => text(given.y)),
  };
}

/** Decodes the snapshot key set, skipping keys of another kind. @internal */
export const decodeSnapshotKeys: Decoder = (value) =>
  ({
    keys: at("keys", () =>
      list(object<Wire.SnapshotKeySet>(value).keys, snapshotKey).filter((key): key is SnapshotKey => key !== null),
    ),
  }) satisfies SnapshotKeySet;

function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
  return value === null || value === undefined ? null : decode(value);
}

function claimLimit(value: unknown): Limit {
  return value === "unlimited" ? "unlimited" : whole(value);
}

function claimValue(value: unknown, entitled: boolean): Value {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return value ? true : 0;
  if (Array.isArray(value)) return entitled ? true : 0;
  return claimLimit(value);
}

function claimSource(value: unknown): EntitlementSource | null {
  const given = object<Record<string, unknown>>(value);
  const through = () => at("through", () => nullable(given.through, text));
  const sourceValue = () => at("value", () => nullable(given.value, (held) => claimValue(held, true)));
  const plan = () => {
    const named = at("plan", () => object<Record<string, unknown>>(given.plan));
    return {
      planId: at("plan", () => at("id", () => text(named.id))),
      plan: at("plan", () => at("key", () => text(named.key))),
      name: at("plan", () => at("name", () => text(named.name))),
      version: at("version", () => whole(given.version)),
    };
  };
  switch (given.type) {
    case "plan":
    case "default_plan":
      return {
        type: "plan",
        ...plan(),
        product: at("product", () => nullable(given.product, text)),
        byDefault: given.type === "default_plan",
        value: given.type === "plan" ? sourceValue() : null,
        through: through(),
      };
    case "add_on":
      return {
        type: "addon",
        ...plan(),
        quantity: at("quantity", () => whole(given.quantity)),
        value: sourceValue(),
        through: through(),
      };
    case "grant":
      return {
        type: "grant",
        grant: at("grant", () => text(given.grant)),
        until: at("until", () => nullable(given.until, seconds)),
        value: sourceValue(),
        through: through(),
      };
    case "group":
      return { type: "group", features: at("features", () => list(given.features, text)) };
    default:
      return null;
  }
}

function claimEntitlement(value: unknown): Entitlement {
  const given = object<Record<string, unknown>>(value);
  const entitled = at("entitled", () => bool(given.entitled));
  const type: FeatureType = at("kind", () => text(given.kind));
  return {
    key: at("key", () => text(given.key)),
    type,
    entitled,
    value: at("value", () => claimValue(given.value, entitled)),
    sources: at("sources", () =>
      list(given.sources, claimSource).filter((known): known is EntitlementSource => known !== null),
    ),
    upgrades: [],
    meter:
      type !== "metered"
        ? null
        : given.used === undefined
          ? { used: 0, held: 0, banked: 0, remaining: 0, resetsAt: null }
          : {
              used: at("used", () => whole(given.used)),
              held: at("held", () => whole(given.held)),
              banked: at("banked", () => whole(given.banked)),
              remaining: at("remaining", () => claimLimit(given.remaining)),
              resetsAt: at("resetsAt", () => nullable(given.resetsAt, seconds)),
            },
  };
}

function claimServed(given: Record<string, unknown>): Served {
  const track = given.track === undefined ? null : object<Record<string, unknown>>(given.track);
  const release = given.release === undefined ? null : object<Record<string, unknown>>(given.release);
  const change = given.change === undefined ? null : object<Record<string, unknown>>(given.change);
  return {
    track:
      track && at("track", () => ({ id: at("id", () => text(track.id)), name: at("name", () => text(track.name)) })),
    source: release
      ? at("release", () => ({
          type: "release" as const,
          id: at("id", () => text(release.id)),
          number: at("number", () => whole(release.number)),
        }))
      : change
        ? at("change", () => ({ type: "change" as const, id: at("id", () => text(change.id)) }))
        : { type: "nothing" },
  };
}

/** A snapshot's signed claims, decoded. @internal */
export interface SnapshotClaims {
  readonly issuer: string;
  readonly customer: string;
  readonly environment: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly served: Served;
  readonly entitlements: readonly Entitlement[];
}

/** Decodes a snapshot's claims, throwing `TypeError` when they do not fit. @internal */
export function decodeClaims(value: unknown): SnapshotClaims {
  const given = object<Record<string, unknown>>(value);
  return {
    issuer: at("iss", () => text(given.iss)),
    customer: at("sub", () => text(given.sub)),
    environment: at("environment", () => at("id", () => text(object<Record<string, unknown>>(given.environment).id))),
    issuedAt: at("iat", () => seconds(given.iat)),
    expiresAt: at("exp", () => seconds(given.exp)),
    served: claimServed(given),
    entitlements: at("entitlements", () => list(given.entitlements, claimEntitlement)),
  };
}
