import type {
  Actor,
  Amount,
  AnswerContext,
  BilledProduct,
  BillingDrift,
  Check,
  CustomerBilling,
  CustomerPlans,
  CustomerPricing,
  CustomerRecord,
  Entitlement,
  EntitlementSource,
  FeatureImpact,
  FeatureType,
  Grant,
  GrantResult,
  HeldAddOn,
  HeldDiscount,
  HeldPlan,
  Holdings,
  IssuedCustomerToken,
  Lane,
  Limit,
  ListingPrice,
  Markets,
  Meter,
  MoveStep,
  PlanChange,
  PlanOption,
  PricedPlan,
  PriceLine,
  PricingMarket,
  PricingSheet,
  RegisteredCustomer,
  RevokedGrant,
  Served,
  Snapshot,
  SnapshotKey,
  SnapshotKeySet,
  TrackAssignment,
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

function markets(value: unknown): Markets | null {
  const money = value === undefined ? undefined : object<Wire.FeatureValue>(value).money;
  if (money === undefined) return null;
  return at("money", () =>
    Object.fromEntries(
      at("limits", () =>
        list(object<Wire.MarketLimits>(money).limits, (item) => {
          const market = object<Wire.MarketLimit>(item);
          return [at("marketId", () => text(market.marketId)), at("limit", () => limit(market.limit ?? {}))];
        }),
      ),
    ),
  );
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
      markets: at("value", () => markets(plan.value)),
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
      markets: at("value", () => markets(addOn.value)),
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
      markets: at("value", () => markets(grant.value)),
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
    markets: at("value", () => markets(given.value)),
    decimals: at("decimals", () => whole(given.decimals)),
    currency: at("currency", () => text(given.currency) || null),
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
        saturated: at("saturated", () => bool(usage.saturated)),
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

function actor(value: unknown): Actor | null {
  if (value === undefined) return null;
  const given = object<Wire.Actor>(value);
  return { type: at("type", () => enumName(given.type, "ACTOR_TYPE_")), id: at("id", () => text(given.id)) };
}

function grantValue(value: unknown): true | Limit {
  const given = object<Wire.GrantValue>(value);
  if (given.on !== undefined) return true;
  return at("limit", () => limit(given.limit));
}

function grant(value: unknown): Grant {
  const given = object<Wire.Grant>(value);
  return {
    id: at("id", () => text(given.id)),
    feature: at("featureKey", () => text(given.featureKey)),
    value: at("value", () => grantValue(given.value)),
    from: at("from", () => seconds(given.from)),
    until: at("until", () => optionalSeconds(given.until)),
    reason: at("reason", () => text(given.reason)),
    revokedAt: at("revokedAt", () => optionalSeconds(given.revokedAt)),
    revokeReason: at("revokeReason", () => optionalText(given.revokeReason)),
    grantedBy: at("grantedBy", () => actor(given.grantedBy)),
    revokedBy: at("revokedBy", () => actor(given.revokedBy)),
  };
}

/** Decodes `Grants.CreateGrant`'s answer. @internal */
export const decodeGrant: Decoder = (value) => {
  const given = object<Wire.CreateGrantResponse>(value);
  return {
    grant: at("grant", () => grant(given.grant)),
    revision: at("revision", () => whole(given.revision)),
  } satisfies GrantResult;
};

/** Decodes `Grants.RevokeGrant`'s answer. @internal */
export const decodeRevokedGrant: Decoder = (value) => {
  const given = object<Wire.RevokeGrantResponse>(value);
  return {
    grant: at("grant", () => grant(given.grant)),
    revision: at("revision", () => whole(given.revision)),
    changed: at("changed", () => bool(given.changed)),
  } satisfies RevokedGrant;
};

/** Decodes `CustomerTracks.AssignTrack`'s answer. @internal */
export const decodeTrack: Decoder = (value) => {
  const given = object<Wire.AssignTrackResponse>(value);
  const assignment = at("assignment", () => object<Wire.CustomerTrack>(given.assignment));
  return {
    ...at("assignment", () => ({
      track: at("trackId", () => optionalText(assignment.trackId)),
      previousTrack: at("previousTrackId", () => optionalText(assignment.previousTrackId)),
      source: at("source", () => enumName(assignment.source, "ASSIGNMENT_SOURCE_")),
      money: at("money", () => enumName(assignment.money, "CUSTOMER_MONEY_")),
      revision: at("revision", () => whole(assignment.revision)),
    })),
    changed: at("changed", () => bool(given.changed)),
    endedTestHoldings: at("endedTestHoldings", () => whole(given.endedTestHoldings)),
  } satisfies TrackAssignment;
};

function heldPlan(value: unknown): HeldPlan {
  const given = object<Wire.HeldPlan>(value);
  return {
    id: at("planId", () => text(given.planId)),
    key: at("planKey", () => text(given.planKey)),
    name: at("planName", () => text(given.planName)),
    version: at("versionNumber", () => whole(given.versionNumber)),
    byDefault: at("byDefault", () => bool(given.byDefault)),
    money: at("money", () => enumName(given.money, "CUSTOMER_MONEY_")),
    period: at("periodId", () => optionalText(given.periodId)),
  };
}

function planChange(value: unknown): PlanChange {
  const given = object<Wire.PlanChange>(value);
  return {
    product: at("productId", () => optionalText(given.productId)),
    plan: at("plan", () => nullable(given.plan, heldPlan)),
    quantity: at("quantity", () => (given.quantity === undefined ? null : whole(given.quantity))),
    effective: at("effective", () => enumName(given.effective, "EFFECTIVE_")),
    at: at("at", () => seconds(given.at)),
    until: at("until", () => optionalSeconds(given.until)),
    changed: at("changed", () => bool(given.changed)),
    policy: at("policy", () => enumName(given.policy, "SUBSCRIPTION_MOVE_POLICY_")),
  };
}

function optionalWhole(value: unknown): number | null {
  return value === undefined ? null : whole(value);
}

function heldAddOn(value: unknown): HeldAddOn {
  const given = object<Wire.HeldAddOn>(value);
  return {
    id: at("planId", () => text(given.planId)),
    key: at("planKey", () => text(given.planKey)),
    name: at("planName", () => text(given.planName)),
    version: at("versionNumber", () => whole(given.versionNumber)),
    money: at("money", () => enumName(given.money, "CUSTOMER_MONEY_")),
    quantity: at("quantity", () => whole(given.quantity)),
    required: at("required", () => bool(given.required)),
    addedAt: at("addedAt", () => seconds(given.addedAt)),
  };
}

function heldDiscount(value: unknown): HeldDiscount {
  const given = object<Wire.HeldDiscount>(value);
  return {
    offerKey: at("offerKey", () => text(given.offerKey)),
    offerName: at("offerName", () => text(given.offerName)),
    amount: at("amount", () => nullable(given.amount, amount)),
    percentThousandths: at("percentThousandths", () => optionalWhole(given.percentThousandths)),
    until: at("until", () => optionalSeconds(given.until)),
    applied: at("applied", () => bool(given.applied)),
  };
}

function lane(value: unknown): Lane {
  const given = object<Wire.LaneHolding>(value);
  return {
    product: at("productId", () => optionalText(given.productId)),
    plan: at("plan", () => nullable(given.plan, heldPlan)),
    addOns: at("addOns", () => list(given.addOns, heldAddOn)),
    startedAt: at("startedAt", () => optionalSeconds(given.startedAt)),
    renewsAt: at("renewsAt", () => optionalSeconds(given.renewsAt)),
    trialEndsAt: at("trialEndsAt", () => optionalSeconds(given.trialEndsAt)),
    cancelsAt: at("cancelsAt", () => optionalSeconds(given.cancelsAt)),
    paidUntil: at("paidUntil", () => optionalSeconds(given.paidUntil)),
    until: at("until", () => optionalSeconds(given.until)),
    collection: at("collection", () => enumName(given.collection, "SUBSCRIPTION_COLLECTION_")),
    pending: at("pending", () =>
      nullable(given.pending, (pending) => {
        const booked = object<Wire.PendingChange>(pending);
        const move =
          booked.move === undefined ? undefined : at("move", () => object<Wire.PendingPlanMove>(booked.move));
        return {
          at: at("at", () => seconds(booked.at)),
          cancel: booked.cancel !== undefined,
          plan: at("move", () => (move === undefined ? null : at("planId", () => text(move.planId)))),
          period: at("move", () => (move === undefined ? null : at("periodId", () => optionalText(move.periodId)))),
        };
      }),
    ),
    cancellation: at("cancellation", () =>
      nullable(given.cancellation, (cancellation) => {
        const ending = object<Wire.Cancellation>(cancellation);
        return {
          endsAt: at("endsAt", () => seconds(ending.endsAt)),
          exitFee: at("exitFee", () => nullable(ending.exitFee, amount)),
          chargedBack: at("chargedBack", () => nullable(ending.chargedBack, amount)),
        };
      }),
    ),
    discounts: at("discounts", () => list(given.discounts, heldDiscount)),
    payment: {
      amount: at("paymentAmount", () => nullable(given.paymentAmount, amount)),
      dueAt: at("paymentDueAt", () => optionalSeconds(given.paymentDueAt)),
      days: at("paymentDays", () => optionalWhole(given.paymentDays)),
    },
  };
}

function holdings(value: unknown): Holdings {
  const given = object<Wire.Holdings>(value);
  return {
    lanes: at("lanes", () => list(given.lanes, lane)),
    grants: at("grants", () => list(given.grants, grant)),
  };
}

function impact(value: unknown): FeatureImpact {
  const given = object<Wire.FeatureImpact>(value);
  return {
    feature: at("featureKey", () => text(given.featureKey)),
    kind: at("kind", () => enumName(given.kind, "IMPACT_KIND_")),
    from: at("from", () => sourceValue(given.from)),
    to: at("to", () => sourceValue(given.to)),
    fromMarkets: at("from", () => markets(given.from)),
    toMarkets: at("to", () => markets(given.to)),
  };
}

function planOption(value: unknown): PlanOption {
  const given = object<Wire.PlanOption>(value);
  return {
    plan: {
      id: at("planId", () => text(given.planId)),
      key: at("planKey", () => text(given.planKey)),
      name: at("planName", () => text(given.planName)),
    },
    product: at("productId", () => optionalText(given.productId)),
    kind: at("kind", () => enumName(given.kind, "OPTION_KIND_")),
    direction: at("direction", () => enumName(given.direction, "PLAN_DIRECTION_")),
    selling: at("selling", () => enumName(given.selling, "SELLING_")),
    timing: at("timing", () => enumName(given.timing, "MOVE_TIMING_")),
    periods: at("periodIds", () => list(given.periodIds, text)),
    replaces: at("replacesPlanId", () => optionalText(given.replacesPlanId)),
    impact: at("impact", () => list(given.impact, impact)),
  };
}

/** Decodes `Subscriptions.ListAvailablePlans`'s answer. @internal */
export const decodePlans: Decoder = (value) => {
  const given = object<Wire.ListAvailablePlansResponse>(value);
  return {
    asOf: at("asOf", () => seconds(given.asOf)),
    customerId: at("customerId", () => optionalText(given.customerId)),
    options: at("options", () => list(given.options, planOption)),
    holdings: at("holdings", () => nullable(given.holdings, holdings)),
  } satisfies Omit<CustomerPlans, "stale">;
};

function drift(value: unknown): BillingDrift {
  const given = object<Wire.BillingDrift>(value);
  return {
    billedPlan: at("billedPlanId", () => text(given.billedPlanId)),
    heldPlan: at("heldPlanId", () => optionalText(given.heldPlanId)),
    product: at("productId", () => optionalText(given.productId)),
    observedAt: at("observedAt", () => seconds(given.observedAt)),
  };
}

function billed(given: Wire.BilledProduct | Wire.CustomerBilling): Omit<BilledProduct, "product" | "connectionId"> {
  return {
    status: at("status", () => enumName(given.status, "PROVIDER_SUBSCRIPTION_STATUS_")),
    items: at("items", () => whole(given.items)),
    renews: at("renews", () => bool(given.renews)),
    sku: at("sku", () =>
      nullable(given.sku, (sku) => {
        const billedSku = object<Wire.BilledSku>(sku);
        return {
          priceId: at("priceId", () => text(billedSku.priceId)),
          period: at("periodId", () => optionalText(billedSku.periodId)),
          price: at("price", () => nullable(billedSku.price, listingPrice)),
        };
      }),
    ),
    drift: at("drift", () => nullable(given.drift, drift)),
  };
}

function unlinked(): CustomerBilling {
  return {
    linked: false,
    connectionId: null,
    status: "unspecified",
    items: 0,
    renews: false,
    sku: null,
    drift: null,
    products: [],
  };
}

/** Decodes `Billing.GetBilling`'s answer. @internal */
export const decodeBilling: Decoder = (value) => {
  const billing = object<Wire.GetBillingResponse>(value).billing;
  if (billing === undefined) return unlinked();
  const given = at("billing", () => object<Wire.CustomerBilling>(billing));
  return at("billing", () => ({
    linked: at("linked", () => bool(given.linked)),
    connectionId: at("connectionId", () => optionalText(given.connectionId)),
    ...billed(given),
    products: at("products", () =>
      list(given.products, (item) => {
        const product = object<Wire.BilledProduct>(item);
        return {
          product: at("productId", () => optionalText(product.productId)),
          connectionId: at("connectionId", () => text(product.connectionId)),
          ...billed(product),
        };
      }),
    ),
  })) satisfies CustomerBilling;
};

/** Decodes `Billing.CreatePortalSession`'s answer. @internal */
export const decodePortal: Decoder = (value) => {
  const given = object<Wire.CreatePortalSessionResponse>(value);
  return { url: at("url", () => text(given.url)) };
};

/** Decodes `Billing.SyncBilling`'s answer. @internal */
export const decodeSync: Decoder = (value) => {
  const given = object<Wire.SyncBillingResponse>(value);
  return { changed: at("changed", () => bool(given.changed)) };
};

/** Decodes a plan move's answer. @internal */
export const decodeMove: Decoder = (value) => {
  const given = object<Wire.SetPlanResponse>(value);
  if (given.pay !== undefined) {
    const pay = at("pay", () => object<Wire.PaymentStep>(given.pay));
    return at("pay", () => ({
      next: "pay",
      url: at("url", () => text(pay.url)),
      status: at("status", () => enumName(pay.status, "PAYMENT_STEP_STATUS_")),
    })) satisfies MoveStep;
  }
  if (given.confirming !== undefined) return { next: "confirming" } satisfies MoveStep;
  const done = at("done", () => object<Wire.MoveResult>(given.done));
  return at("done", () => ({
    next: "done",
    result: {
      customerId: at("customerId", () => text(done.customerId)),
      revision: at("revision", () => whole(done.revision)),
      money: at("money", () => enumName(done.money, "CUSTOMER_MONEY_")),
      change: at("change", () => nullable(done.change, planChange)),
      holdings: at("holdings", () => nullable(done.holdings, holdings)),
    },
  })) satisfies MoveStep;
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

function claimValue(value: unknown, entitled: boolean, type: FeatureType): Value {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return value ? true : 0;
  if (Array.isArray(value)) return type === "group" && entitled ? true : 0;
  return claimLimit(value);
}

function claimMarkets(value: unknown, type: FeatureType): Markets | null {
  if (type === "group" || !Array.isArray(value)) return null;
  return Object.fromEntries(
    list(value, (item) => {
      const market = object<Record<string, unknown>>(item);
      return [at("marketId", () => text(market.marketId)), at("limit", () => claimLimit(market.limit))];
    }),
  );
}

function claimSource(value: unknown, type: FeatureType): EntitlementSource | null {
  const given = object<Record<string, unknown>>(value);
  const through = () => at("through", () => nullable(given.through, text));
  const sourceValue = () => at("value", () => nullable(given.value, (held) => claimValue(held, true, type)));
  const sourceMarkets = () => at("value", () => claimMarkets(given.value, type));
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
        markets: given.type === "plan" ? sourceMarkets() : null,
        through: through(),
      };
    case "add_on":
      return {
        type: "addon",
        ...plan(),
        quantity: at("quantity", () => whole(given.quantity)),
        value: sourceValue(),
        markets: sourceMarkets(),
        through: through(),
      };
    case "grant":
      return {
        type: "grant",
        grant: at("grant", () => text(given.grant)),
        until: at("until", () => nullable(given.until, seconds)),
        value: sourceValue(),
        markets: sourceMarkets(),
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
    value: at("value", () => claimValue(given.value, entitled, type)),
    markets: at("value", () => claimMarkets(given.value, type)),
    decimals: at("decimals", () => (given.decimals === undefined ? 0 : whole(given.decimals))),
    currency: at("currency", () => nullable(given.currency, text)),
    sources: at("sources", () =>
      list(given.sources, (item) => claimSource(item, type)).filter(
        (known): known is EntitlementSource => known !== null,
      ),
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

function amount(value: unknown): Amount {
  const given = object<Wire.Amount>(value);
  return {
    amount: at("amount", () => integer(given.amount)),
    currency: at("currency", () => text(given.currency)),
    display: at("display", () => text(given.display)),
  };
}

function pricingMarket(value: unknown): PricingMarket {
  const given = object<Wire.PricingMarket>(value);
  return {
    id: at("id", () => text(given.id)),
    key: at("key", () => text(given.key)),
    name: at("name", () => text(given.name)),
    currency: at("currency", () => text(given.currency)),
    tax: at("tax", () => enumName(given.tax, "MARKET_TAX_")),
  };
}

function feeSchedule(value: unknown) {
  const given = object<Wire.FeeSchedule>(value);
  if (given.onPurchase !== undefined) return { type: "on_purchase" as const };
  if (given.everyMonths !== undefined) {
    const every = object<Wire.EveryMonths>(given.everyMonths);
    return at("everyMonths", () => ({
      type: "every_months" as const,
      months: at("months", () => whole(every.months)),
      firstAfterMonths: at("firstAfterMonths", () => whole(every.firstAfterMonths)),
    }));
  }
  if (given.yearlyOn !== undefined) {
    const yearly = object<Wire.YearlyOn>(given.yearlyOn);
    return at("yearlyOn", () => ({
      type: "yearly" as const,
      dates: at("dates", () =>
        list(yearly.dates, (item) => {
          const date = object<Wire.YearlyDate>(item);
          return { month: at("month", () => whole(date.month)), day: at("day", () => whole(date.day)) };
        }),
      ),
    }));
  }
  return null;
}

function listingIds(value: unknown): Record<string, string> {
  const given = object<Record<string, unknown>>(value);
  const ids: Record<string, string> = {};
  for (const provider of ["apple", "google", "stripe"]) {
    if (given[provider] === undefined) continue;
    at(provider, () => {
      for (const [name, id] of Object.entries(object<Record<string, unknown>>(given[provider]))) {
        ids[name] = at(name, () => text(id));
      }
    });
  }
  return ids;
}

function channel(value: unknown) {
  const given = object<Wire.PricedChannel>(value);
  return {
    provider: at("provider", () => enumName(given.provider, "PAYMENT_PROVIDER_")),
    connectionId: at("connectionId", () => text(given.connectionId)),
    name: at("name", () => text(given.name)),
    mode: at("mode", () => enumName(given.mode, "CONNECTION_MODE_")),
    purchasable: at("purchasable", () => bool(given.purchasable)),
    ids: at("ids", () => (given.ids === undefined ? {} : listingIds(given.ids))),
    price: at("price", () => nullable(given.price, listingPrice)),
  };
}

function listingPrice(value: unknown): ListingPrice {
  const listed = object<Wire.ListingPrice>(value);
  return {
    amount: at("amount", () => integer(listed.amount)),
    currency: at("currency", () => text(listed.currency)),
    interval: at("interval", () => enumName(listed.interval, "LISTING_PRICE_INTERVAL_")),
    intervalCount: at("intervalCount", () => whole(listed.intervalCount)),
    tax: at("tax", () => enumName(listed.tax, "LISTING_TAX_BEHAVIOUR_")),
  };
}

function pricedPlan(value: unknown): PricedPlan {
  const given = object<Wire.PricedPlan>(value);
  return {
    id: at("id", () => text(given.id)),
    key: at("key", () => text(given.key)),
    name: at("name", () => text(given.name)),
    description: at("description", () => text(given.description)),
    kind: at("kind", () => enumName(given.kind, "PLAN_KIND_")),
    product: at("productId", () => optionalText(given.productId)),
    version: at("versionNumber", () => whole(given.versionNumber)),
    byDefault: at("byDefault", () => bool(given.byDefault)),
    status: at("status", () => enumName(given.status, "PLAN_STATUS_")),
    salesLed: at("salesLed", () => bool(given.salesLed)),
    priceState: at("priceState", () => enumName(given.priceState, "PLAN_PRICE_STATE_")),
    trial: at("trial", () =>
      nullable(given.trial, (trial) => {
        const length = object<Wire.TrialLength>(trial);
        return {
          days: at("days", () => whole(length.days ?? 0)),
          months: at("months", () => whole(length.months ?? 0)),
        };
      }),
    ),
    quantity: at("quantity", () =>
      nullable(given.quantity, (quantity) => {
        const rule = object<Wire.QuantityRule>(quantity);
        return { min: at("min", () => whole(rule.min)), max: at("max", () => nullable(rule.max, whole)) };
      }),
    ),
    periods: at("periods", () =>
      list(given.periods, (item) => {
        const period = object<Wire.PricedPeriod>(item);
        return {
          id: at("id", () => text(period.id)),
          key: at("key", () => text(period.key)),
          label: at("label", () => text(period.label)),
          count: at("count", () => whole(period.count)),
          unit: at("unit", () => enumName(period.unit, "PERIOD_UNIT_")),
        };
      }),
    ),
    prices: at("prices", () =>
      list(given.prices, (item) => {
        const price = object<Wire.PeriodPrice>(item);
        return {
          period: at("periodId", () => optionalText(price.periodId)),
          price: at("price", () => nullable(price.price, amount)),
          bands: at("bands", () =>
            list(price.bands, (band) => {
              const priced = object<Wire.PricedBand>(band);
              return {
                upTo: at("upTo", () => nullable(priced.upTo, whole)),
                perUnit: at("perUnit", () => bool(priced.perUnit)),
                amount: at("amount", () => nullable(priced.amount, amount)),
              };
            }),
          ),
        };
      }),
    ),
    fees: at("fees", () =>
      list(given.fees, (item) => {
        const fee = object<Wire.PricedFee>(item);
        return {
          key: at("key", () => text(fee.key)),
          name: at("name", () => text(fee.name)),
          direction: at("direction", () => enumName(fee.direction, "FEE_DIRECTION_")),
          price: at("price", () => nullable(fee.price, amount)),
          schedule: at("schedule", () => nullable(fee.schedule, feeSchedule)),
        };
      }),
    ),
    items: at("items", () =>
      list(given.items, (item) => {
        const planItem = object<Wire.PlanItem>(item);
        return {
          feature: at("featureKey", () => text(planItem.featureKey)),
          value: at("value", () => featureValue(planItem.value, true)),
          markets: at("value", () => markets(planItem.value)),
          bank: at("bank", () => nullable(planItem.bank, limit)),
          benefitThousandths: at("benefitThousandths", () => nullable(planItem.benefitThousandths, whole)),
        };
      }),
    ),
    availableOn: at("availableOn", () => list(given.availableOn, text)),
    listings: at("listings", () =>
      list(given.listings, (item) => {
        const listing = object<Wire.PlanListing>(item);
        return {
          period: at("periodId", () => optionalText(listing.periodId)),
          channels: at("channels", () => list(listing.channels, channel)),
        };
      }),
    ),
  };
}

function pricingSheet(value: unknown): PricingSheet {
  const given = object<Wire.PricingSheet>(value);
  return {
    market: at("market", () => nullable(given.market, pricingMarket)),
    products: at("products", () =>
      list(given.products, (item) => {
        const product = object<Wire.PricedProduct>(item);
        return {
          id: at("id", () => text(product.id)),
          key: at("key", () => text(product.key)),
          name: at("name", () => text(product.name)),
          defaultPlanId: at("defaultPlanId", () => optionalText(product.defaultPlanId)),
        };
      }),
    ),
    plans: at("plans", () => list(given.plans, pricedPlan)),
    served: at("served", () => served(given.served ?? {})),
    testers: at("testers", () => bool(given.testers)),
    customer: at("customer", () => optionalText(given.customer)),
  };
}

/** Decodes `Pricing.GetPricing`'s answer. @internal */
export const decodePricing: Decoder = (value) =>
  at("pricing", () => pricingSheet(object<Wire.GetPricingResponse>(value).pricing));

function priceLine(value: unknown): PriceLine {
  const given = object<Wire.CustomerPriceLine>(value);
  return {
    planId: at("planId", () => text(given.planId)),
    version: at("version", () => whole(given.version)),
    period: at("periodId", () => optionalText(given.periodId)),
    quantity: at("quantity", () => whole(given.quantity)),
    state: at("state", () => enumName(given.state, "PLAN_PRICE_STATE_")),
    price: at("price", () => nullable(given.price, amount)),
    unitPrice: at("unitPrice", () => nullable(given.unitPrice, amount)),
    listPrice: at("listPrice", () => nullable(given.listPrice, amount)),
    discounts: at("discounts", () =>
      list(given.discounts, (item) => {
        const discount = object<Wire.CustomerLineDiscount>(item);
        return {
          offerId: at("offerId", () => text(discount.offerId)),
          offerKey: at("offerKey", () => text(discount.offerKey)),
          offerName: at("offerName", () => text(discount.offerName)),
          amount: at("amount", () => nullable(discount.amount, amount)),
        };
      }),
    ),
  };
}

/** Decodes `Pricing.GetCustomerPricing`'s answer. @internal */
export const decodeCustomerPricing: Decoder = (value) => {
  const given = object<Wire.GetCustomerPricingResponse>(value);
  return {
    ...at("pricing", () => pricingSheet(given.pricing)),
    prices: at("prices", () =>
      nullable(given.prices, (prices) => {
        const customer = object<Wire.CustomerPrices>(prices);
        return {
          market: at("market", () => nullable(customer.market, pricingMarket)),
          subscriptions: at("subscriptions", () =>
            list(customer.subscriptions, (item) => {
              const subscription = object<Wire.SubscriptionPrice>(item);
              return {
                subscriptionId: at("subscriptionId", () => text(subscription.subscriptionId)),
                product: at("productId", () => optionalText(subscription.productId)),
                renewsAt: at("renewsAt", () => seconds(subscription.renewsAt)),
                now: at("now", () => list(subscription.now, priceLine)),
                atRenewal: at("atRenewal", () =>
                  nullable(subscription.atRenewal, (lines) =>
                    at("lines", () => list(object<Wire.CustomerPriceLines>(lines).lines, priceLine)),
                  ),
                ),
                nextCharges: at("nextCharges", () =>
                  list(subscription.nextCharges, (charge) => {
                    const next = object<Wire.NextCharge>(charge);
                    return {
                      fee: at("feeKey", () => text(next.feeKey)),
                      direction: at("direction", () => enumName(next.direction, "FEE_DIRECTION_")),
                      at: at("at", () => seconds(next.at)),
                      amount: at("amount", () => nullable(next.amount, amount)),
                    };
                  }),
                ),
              };
            }),
          ),
        };
      }),
    ),
  } satisfies CustomerPricing;
};
