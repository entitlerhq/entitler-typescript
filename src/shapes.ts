type Json = Record<string, unknown>;
type Rule = (value: unknown) => boolean;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str: Rule = (value) => typeof value === "string";
const bool: Rule = (value) => typeof value === "boolean";
const int: Rule = (value) => Number.isSafeInteger(value);
const instant: Rule = (value) => value instanceof Date;
const array: Rule = (value) => Array.isArray(value);
const nullable =
  (rule: Rule): Rule =>
  (value) =>
    value === null || rule(value);
const optional =
  (rule: Rule): Rule =>
  (value) =>
    value === undefined || rule(value);
const list =
  (rule: Rule): Rule =>
  (value) =>
    Array.isArray(value) && value.every(rule);
const shape =
  (fields: Record<string, Rule>): Rule =>
  (value) =>
    isObject(value) && Object.entries(fields).every(([name, rule]) => rule(value[name]));

function isAmount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** True for a feature value: on, a whole amount, or unlimited. @internal */
export function isValue(value: unknown): boolean {
  return value === true || value === "unlimited" || isAmount(value);
}

const limit: Rule = (value) => value === "unlimited" || isAmount(value);

const meter = {
  used: optional(int),
  held: optional(int),
  remaining: optional(limit),
  resetsAt: optional(nullable(instant)),
};

const context = {
  environment: shape({ id: str, name: str, kind: str }),
  track: shape({ id: str, name: str }),
  release: nullable(int),
  change: nullable(str),
  testers: bool,
  experiment: nullable(shape({ id: str, arm: str })),
};

const upgrade = shape({ plan: str, name: str, move: str, action: str, reason: nullable(str) });
const period = shape({ key: str, label: str });
const product = nullable(shape({ key: str, name: str }));
const plan = shape({ id: str, key: str, name: str });
const planWithKind = shape({ id: str, key: str, name: str, kind: str });

const checkFields = {
  customer: str,
  feature: str,
  type: str,
  entitled: bool,
  value: isValue,
  asOf: instant,
  sources: array,
  upgrades: list(upgrade),
  ...context,
  ...meter,
};

/** True for an entitlement in a list or a snapshot. @internal */
export const isEntitlement: Rule = shape({
  key: str,
  type: str,
  entitled: bool,
  value: isValue,
  upgrades: optional(list(upgrade)),
  ...meter,
});

/** True for a check answer with every field the API documents, each of its type. @internal */
export const isCheck: Rule = shape(checkFields);

/** True for an entitlement list. @internal */
export const isEntitlements: Rule = shape({
  customer: str,
  asOf: instant,
  entitlements: list(isEntitlement),
  ...context,
});

const price = shape({ amount: int, currency: str, interval: nullable(str), intervalCount: int, tax: str });
const sku = shape({
  period: nullable(period),
  connector: str,
  ids: (value) => isObject(value) && Object.values(value).every(str),
  price: optional(nullable(price)),
});
const KNOWN_PENDING: Record<string, Rule> = {
  move: (value) => plan((value as Json).plan),
  cancel: (value) => nullable(plan)((value as Json).movingTo),
  billing: (value) => str((value as Json).billing),
};
const pending = nullable(
  (value) => isObject(value) && typeof value.type === "string" && (KNOWN_PENDING[value.type]?.(value) ?? true),
);

/** A booked change as the SDK answers it: a type this SDK does not know becomes `unknown` with its raw object. @internal */
export function pendingOf(value: unknown): unknown {
  if (!isObject(value) || Object.hasOwn(KNOWN_PENDING, value.type as string)) return value;
  return { type: "unknown", raw: value };
}

/** True for the customer's plans. @internal */
export const isPlans: Rule = shape({
  customer: str,
  asOf: instant,
  held: list(
    shape({
      plan: planWithKind,
      product,
      version: nullable(int),
      byDefault: bool,
      period: nullable(period),
      renewsAt: nullable(instant),
      pending,
      billedBy: nullable(str),
    }),
  ),
  options: list(
    shape({
      plan: shape({ id: str, key: str, name: str, kind: str, description: str, default: bool }),
      product,
      from: nullable(plan),
      move: str,
      action: str,
      reason: nullable(str),
      when: str,
      periods: list(period),
      impact: list(shape({ kind: str, text: str })),
      skus: list(sku),
    }),
  ),
  ...context,
});

/** The customer's plans with each SKU's missing price as `null` and each booked change decoded. @internal */
export function plansOf(data: Json): Json {
  const held = (data.held as Json[]).map((each) => ({ ...each, pending: pendingOf(each.pending) }));
  const options = (data.options as Json[]).map((option) => ({
    ...option,
    skus: (option.skus as Json[]).map((each) => ({ ...each, price: each.price ?? null })),
  }));
  return { ...data, held, options };
}

function subscriptionOf(value: unknown): unknown {
  return isObject(value) ? { ...value, pending: pendingOf(value.pending) } : value;
}

/** A customer's details with each subscription's booked change decoded. @internal */
export function detailsOf(data: Json): Json {
  const products = Array.isArray(data.products)
    ? data.products.map((each) =>
        isObject(each) ? { ...each, subscription: subscriptionOf(each.subscription) } : each,
      )
    : data.products;
  return { ...data, subscription: subscriptionOf(data.subscription), products };
}

/** True for a usage write's answer. @internal */
export const isUsageResult: Rule = shape({
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
  product,
  plan: nullable(plan),
  quantity: nullable(int),
  effective: str,
  at: instant,
  until: nullable(instant),
  changed: bool,
};

/** True for a plan change. @internal */
export const isPlanChange: Rule = shape(planChangeFields);

/** True for `subscribe`'s next step. @internal */
export const isStep: Rule = (value) => {
  if (!isObject(value) || typeof value.next !== "string") return false;
  if (value.next === "done") return isPlanChange(value);
  if (value.next === "pay") return str(value.url);
  if (value.next === "manage") return str(value.billedBy);
  return true;
};

/** A grant's value as a feature value: empty is on, `unlimited` is unlimited, digits are an amount. @internal */
export function grantValue(text: unknown): true | number | "unlimited" | undefined {
  if (text === "") return true;
  if (text === "unlimited") return "unlimited";
  if (typeof text === "string" && /^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  return undefined;
}

/** True for a grant made or revoked. @internal */
export const isGrantChange: Rule = shape({
  grant: shape({
    id: str,
    feature: str,
    value: (value) => grantValue(value) !== undefined,
    from: instant,
    until: nullable(instant),
    revokedAt: nullable(instant),
    reason: str,
    by: str,
    actor: nullable(str),
  }),
});

/** A grant change with the grant's value decoded. @internal */
export function grantChangeOf(data: Json): Json {
  const grant = data.grant as Json;
  return { ...data, grant: { ...grant, value: grantValue(grant.value) } };
}

/** True for a provider page. @internal */
export const isProviderPage: Rule = shape({ url: str });

/** True for a billing sync's answer. @internal */
export const isBillingSync: Rule = shape({ changed: bool });
