import { calendarInstant } from "./util.js";

type Json = Record<string, unknown>;

/** Checks one part of an answer and answers it decoded, throwing `TypeError` when it does not fit. @internal */
export type Decoder = (value: unknown) => unknown;

interface Optional extends Decoder {
  readonly optional: true;
}

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

function within<T>(step: string | number, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof Mismatch) throw new Mismatch([step, ...error.path]);
    throw error;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const is =
  (test: (value: unknown) => boolean): Decoder =>
  (value) =>
    test(value) ? value : fail();

const str = is((value) => typeof value === "string");
const bool = is((value) => typeof value === "boolean");
const int = is((value) => Number.isSafeInteger(value));
const amount = is((value) => Number.isSafeInteger(value) && (value as number) >= 0);
const raw: Decoder = (value) => value;

/** True for a feature value: on, a whole amount, or unlimited. @internal */
export function isValue(value: unknown): boolean {
  return value === true || value === "unlimited" || (Number.isSafeInteger(value) && (value as number) >= 0);
}

const value = is(isValue);
const limit = is((given) => given === "unlimited" || (Number.isSafeInteger(given) && (given as number) >= 0));
const featureValue = is(
  (given) => typeof given === "boolean" || typeof given === "string" || Number.isSafeInteger(given),
);

const instant: Decoder = (given) => {
  const date = typeof given === "string" ? calendarInstant(given) : undefined;
  return date ?? fail();
};

const nullable =
  (decode: Decoder): Decoder =>
  (given) =>
    given === null ? null : decode(given);

const optional = (decode: Decoder): Optional =>
  Object.assign((given: unknown) => (given === undefined ? undefined : decode(given)), { optional: true as const });

const list =
  (decode: Decoder): Decoder =>
  (given) =>
    Array.isArray(given) ? given.map((each, index) => within(index, () => decode(each))) : fail();

const record =
  (decode: Decoder): Decoder =>
  (given) =>
    isObject(given)
      ? Object.fromEntries(Object.entries(given).map(([name, each]) => [name, within(name, () => decode(each))]))
      : fail();

const shape =
  (fields: Record<string, Decoder>): Decoder =>
  (given) => {
    if (!isObject(given)) fail();
    const decoded: Json = { ...given };
    for (const [name, decode] of Object.entries(fields)) {
      if ((decode as Partial<Optional>).optional && given[name] === undefined) continue;
      decoded[name] = within(name, () => decode(given[name]));
    }
    return decoded;
  };

const then =
  (decode: Decoder, change: (decoded: Json) => unknown): Decoder =>
  (given) =>
    change(decode(given) as Json);

const tagged =
  (tag: string, known: Record<string, Decoder>, unknown: (given: Json) => unknown = (given) => given): Decoder =>
  (given) => {
    const kind = shape({ [tag]: str })(given) as Json;
    const decode = Object.hasOwn(known, kind[tag] as string) ? known[kind[tag] as string] : undefined;
    return decode ? decode(kind) : unknown(kind);
  };

const environment = shape({ id: str, name: str, kind: str });
const track = shape({ id: str, name: str });
const context = {
  environment,
  track,
  release: nullable(int),
  change: nullable(str),
  testers: bool,
  experiment: nullable(shape({ id: str, arm: str })),
};
const meter = {
  used: optional(int),
  held: optional(int),
  remaining: optional(limit),
  resetsAt: optional(nullable(instant)),
};
const source = tagged("type", { grant: shape({ grant: str, until: nullable(instant), value }) });
const upgrade = shape({ plan: str, name: str, move: str, action: str, reason: nullable(str) });
const period = shape({ key: str, label: str });
const product = shape({ key: str, name: str });
const plan = shape({ id: str, key: str, name: str });
const channel = shape({ provider: str, connectionId: str });
const ids = record(str);
const price = shape({ amount: int, currency: str, interval: nullable(str), intervalCount: int, tax: str });
const offeredSku = then(
  shape({ period: nullable(period), connector: str, ids, price: optional(nullable(price)) }),
  (sku) => ({ ...sku, price: sku.price ?? null }),
);

const checkFields = {
  customer: str,
  feature: str,
  type: str,
  entitled: bool,
  value,
  asOf: instant,
  sources: list(source),
  upgrades: list(upgrade),
  ...context,
  ...meter,
};

const entitlementFields = { key: str, type: str, entitled: bool, value, sources: list(source), ...meter };

/** Decodes an entitlement in a list. @internal */
export const decodeEntitlement: Decoder = shape({ ...entitlementFields, upgrades: list(upgrade) });

/** Decodes an entitlement a snapshot signs, which has no upgrades, giving it none. @internal */
export const decodeSignedEntitlement: Decoder = then(shape(entitlementFields), (decoded) => ({
  ...decoded,
  upgrades: [],
}));

/** Decodes a check. @internal */
export const decodeCheck: Decoder = shape(checkFields);

/** Decodes an entitlement list. @internal */
export const decodeEntitlements: Decoder = shape({
  customer: str,
  asOf: instant,
  entitlements: list(decodeEntitlement),
  ...context,
});

const pending = nullable(
  tagged(
    "type",
    {
      move: shape({ plan }),
      cancel: shape({ movingTo: nullable(plan) }),
      billing: shape({ billing: str }),
    },
    (given) => ({ type: "unknown", raw: given.type }),
  ),
);

const heldPlan = shape({
  plan: shape({ id: str, key: str, name: str, kind: str }),
  product: nullable(product),
  version: nullable(int),
  byDefault: bool,
  period: nullable(period),
  renewsAt: nullable(instant),
  pending,
  billedBy: nullable(str),
});
const moveOption = shape({
  plan: shape({ id: str, key: str, name: str, kind: str, description: str, default: bool }),
  product: nullable(product),
  from: nullable(plan),
  move: str,
  action: str,
  reason: nullable(str),
  when: str,
  periods: list(period),
  impact: list(shape({ kind: str, text: str })),
  skus: list(offeredSku),
});

/** Decodes the customer's plans, each SKU's missing price as `null`. @internal */
export const decodePlans: Decoder = shape({
  customer: str,
  asOf: instant,
  held: list(heldPlan),
  options: list(moveOption),
  ...context,
});

/** Decodes the pricing on sale. @internal */
export const decodePricing: Decoder = shape({
  customer: nullable(str),
  defaultPlan: nullable(str),
  products: list(shape({ key: str, name: str, defaultPlan: nullable(str) })),
  plans: list(
    shape({
      id: str,
      key: str,
      name: str,
      description: str,
      kind: str,
      product: nullable(str),
      salesLed: bool,
      status: str,
      version: nullable(int),
      default: bool,
      periods: list(shape({ key: str, label: str, count: int, unit: str })),
      attachesTo: list(str),
      features: record(featureValue),
      listings: list(
        shape({
          period: nullable(period),
          channels: list(
            shape({
              channel,
              name: str,
              mode: nullable(str),
              purchasable: bool,
              ids: nullable(ids),
              price: optional(nullable(price)),
            }),
          ),
        }),
      ),
    }),
  ),
  ...context,
});

/** Decodes the catalogue's features. @internal */
export const decodeFeatureList: Decoder = shape({
  environment,
  track,
  release: nullable(int),
  change: nullable(str),
  features: list(
    shape({
      id: str,
      key: str,
      name: str,
      type: str,
      description: str,
      unit: str,
      resetEvery: nullable(shape({ count: int, unit: str, anchor: optional(str) })),
      archived: bool,
      includes: list(str),
    }),
  ),
});

/** Decodes the scopes a credential holds. @internal */
export const decodeScopes: Decoder = shape({ scopes: list(str), registration: optional(bool) });

/** Decodes the snapshot key set. @internal */
export const decodeSnapshotKeys: Decoder = shape({
  keys: list(shape({ kty: str, crv: str, x: str, y: str, kid: str, alg: str, use: str })),
});

const usageEvent = shape({
  id: str,
  feature: str,
  amount: int,
  kind: str,
  setTo: nullable(int),
  source: str,
  by: nullable(str),
  actor: nullable(str),
  reason: nullable(str),
  at: instant,
  cancelledAt: nullable(instant),
});

/** Decodes a page of the usage log. @internal */
export const decodeUsagePage: Decoder = shape({ items: list(usageEvent), next: nullable(str) });

/** Decodes the customer's meters and the first page of their usage log. @internal */
export const decodeUsage: Decoder = shape({
  customer: str,
  asOf: instant,
  metersStartAgainAt: nullable(instant),
  features: list(
    shape({
      feature: str,
      type: str,
      entitled: bool,
      value,
      sources: list(source),
      used: int,
      held: int,
      remaining: nullable(limit),
      resetsAt: nullable(instant),
    }),
  ),
  log: decodeUsagePage,
  ...context,
});

/** Decodes a customer as a list, an update or a page shows them. @internal */
export const decodeCustomerSummary: Decoder = shape({
  id: str,
  externalId: str,
  name: str,
  email: str,
  environmentId: str,
  sample: bool,
  createdAt: instant,
  plan: nullable(shape({ id: str, key: str, name: str, version: int })),
  plans: list(shape({ id: str, key: str, name: str, version: int, product: str })),
  defaultPlan: nullable(plan),
  status: str,
  kind: str,
  metadata: record(str),
  track,
  testCustomer: bool,
});

/** Decodes a page of the customer list. @internal */
export const decodeCustomerPage: Decoder = shape({
  items: list(decodeCustomerSummary),
  next: nullable(str),
  used: int,
  limit,
});

/** A grant's value as a feature value: empty is on, `unlimited` is unlimited, digits are an amount. @internal */
export function grantValue(text: unknown): true | number | "unlimited" | undefined {
  if (text === "") return true;
  if (text === "unlimited") return "unlimited";
  if (typeof text === "string" && /^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  return undefined;
}

const grant = shape({
  id: str,
  feature: str,
  value: (given) => grantValue(given) ?? fail(),
  from: instant,
  until: nullable(instant),
  revokedAt: nullable(instant),
  reason: str,
  by: str,
  actor: nullable(str),
});

const purchase = shape({
  money: str,
  channel: nullable(channel),
  release: nullable(int),
  change: nullable(str),
  arm: nullable(str),
});
const heldAddOn = shape({
  plan,
  version: int,
  quantity: int,
  countable: bool,
  addedAt: instant,
  movingTo: nullable(plan),
  purchase,
});
const subscription = shape({
  product,
  plan,
  version: int,
  cohort: nullable(int),
  period: nullable(period),
  startedAt: instant,
  renewsAt: instant,
  billing: nullable(
    shape({
      provider: str,
      startsAt: instant,
      endsAt: instant,
      trialEndsAt: nullable(instant),
      cancelsAt: nullable(instant),
    }),
  ),
  until: nullable(instant),
  addOns: list(heldAddOn),
  pending,
  purchase,
  override: nullable(
    shape({ from: plan, period: nullable(period), billedBy: nullable(channel), since: instant, by: str }),
  ),
});

/** Decodes a customer's details, with the first page of their usage log. @internal */
export const decodeDetails: Decoder = shape({
  customer: decodeCustomerSummary,
  asOf: instant,
  subscription: nullable(subscription),
  defaultPlan: nullable(plan),
  products: list(shape({ product, defaultPlan: nullable(plan), subscription: nullable(subscription) })),
  addOns: list(heldAddOn),
  entitlements: list(decodeEntitlement),
  banked: record(int),
  moveOptions: list(moveOption),
  grants: list(grant),
  usage: decodeUsagePage,
  activity: list(shape({ text: str, at: instant, by: nullable(str), actor: nullable(str), reason: nullable(str) })),
  environment,
});

/** Decodes a customer that registering created or found. @internal */
export const decodeRegistered: Decoder = shape({
  id: str,
  externalId: str,
  environmentId: str,
  createdAt: instant,
  created: bool,
});

/** Decodes a usage write's answer. @internal */
export const decodeUsageResult: Decoder = shape({
  ...checkFields,
  outcome: str,
  refusal: nullable(str),
  id: nullable(str),
  holdId: nullable(str),
  mode: str,
  amount: int,
  meterChange: int,
  overBy: int,
  late: bool,
  occurredAt: nullable(instant),
  expiresAt: nullable(instant),
  reportedAs: str,
});

const planChangeFields = {
  product: nullable(product),
  plan: nullable(plan),
  quantity: nullable(int),
  effective: str,
  at: instant,
  until: nullable(instant),
  changed: bool,
};

/** Decodes a plan change. @internal */
export const decodePlanChange: Decoder = shape(planChangeFields);

/** Decodes `subscribe`'s next step, a step this SDK does not know becoming `unknown` with its raw name. @internal */
export const decodeStep: Decoder = tagged(
  "next",
  {
    done: shape(planChangeFields),
    pay: shape({ url: str }),
    confirming: raw,
    manage: shape({ billedBy: str }),
  },
  (given) => ({ next: "unknown", raw: given.next }),
);

/** Decodes a grant made or revoked. @internal */
export const decodeGrantChange: Decoder = shape({ grant });

/** Decodes a provider page. @internal */
export const decodeProviderPage: Decoder = shape({ provider: str, url: str });

/** Decodes a billing sync's answer. @internal */
export const decodeBillingSync: Decoder = shape({ changed: bool });

/** Decodes a customer token. @internal */
export const decodeCustomerToken: Decoder = shape({
  token: str,
  customer: str,
  scopes: list(str),
  expiresAt: instant,
});

/** Decodes a signed snapshot. @internal */
export const decodeIssuedSnapshot: Decoder = shape({ token: str, expiresAt: instant, keyId: str });

/** Decodes the customer's track after `setTrack`. @internal */
export const decodeCustomerTrack: Decoder = shape({
  customer: str,
  environmentId: str,
  track,
  source: nullable(str),
  previousTrackId: nullable(str),
});

const drift = nullable(shape({ billedPlan: str, heldPlan: nullable(str), observedAt: instant }));

/** Decodes the payment provider's view of the customer. @internal */
export const decodeCustomerBilling: Decoder = shape({
  provider: nullable(str),
  status: nullable(str),
  sku: nullable(offeredSku),
  items: int,
  drift,
  products: list(
    shape({ product: nullable(str), status: nullable(str), sku: nullable(offeredSku), items: int, drift }),
  ),
});

/** Decodes a usage batch's answer. @internal */
export const decodeBatchResult: Decoder = shape({
  results: list(
    shape({
      index: amount,
      outcome: str,
      id: nullable(str),
      late: bool,
      error: nullable(shape({ code: str, message: str })),
    }),
  ),
  recorded: amount,
  duplicates: amount,
  errors: amount,
});

/** Accepts any JSON object, for a call whose answer the SDK does not read. @internal */
export const decodeAnything: Decoder = raw;
