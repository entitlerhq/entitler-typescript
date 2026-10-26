import type {
  AnswerContext,
  Check,
  Entitlement,
  EntitlementSource,
  FeatureType,
  Limit,
  Meter,
  Served,
  Upgrade,
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
  return new Date(whole(value) * 1000);
}

function optionalSeconds(value: unknown): Date | null {
  return value === undefined ? null : seconds(value);
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
      features: at("featureKeys", () => list(group.featureKeys ?? [], text)),
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
    used: at("used", () => whole(given.used ?? 0)),
    held: at("held", () => whole(given.held ?? 0)),
    banked: at("banked", () => whole(given.banked ?? 0)),
    remaining: at("remaining", () => limit(given.remaining ?? { count: 0 })),
    resetsAt: at("resetsAt", () => optionalSeconds(given.resetsAt)),
  };
}

function entitlement(value: unknown): Entitlement {
  const given = object<Wire.Entitlement>(value);
  const entitled = at("entitled", () => (given.entitled === undefined ? false : bool(given.entitled)));
  const type: FeatureType = at("kind", () => enumName(given.kind, "ENTITLED_FEATURE_KIND_"));
  return {
    key: at("featureKey", () => text(given.featureKey)),
    type,
    entitled,
    value: at("value", () => featureValue(given.value, entitled)),
    sources: at("sources", () =>
      list(given.sources ?? [], source).filter((known): known is EntitlementSource => known !== null),
    ),
    upgrades: at("upgrades", () => list(given.upgrades ?? [], upgrade)),
    meter: at("meter", () => (given.meter === undefined ? null : meter(given.meter))),
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

function context(given: Wire.CheckFeatureResponse | Wire.ListEntitlementsResponse): AnswerContext {
  const customer = at("customer", () => object<Wire.EntitledCustomer>(given.customer));
  return {
    customer: at("customer", () => at("externalId", () => text(customer.externalId))),
    customerId: at("customer", () => at("customerId", () => optionalText(customer.customerId))),
    asOf: at("asOf", () => seconds(given.asOf)),
    nextChangeAt: at("nextChangeAt", () => optionalSeconds(given.nextChangeAt)),
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
  return { ...context(given), entitlements: at("entitlements", () => list(given.entitlements ?? [], entitlement)) };
};
