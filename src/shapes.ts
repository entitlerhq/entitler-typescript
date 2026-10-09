type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** True for a feature value: on, a whole amount, or unlimited. @internal */
export function isValue(value: unknown): boolean {
  return value === true || value === "unlimited" || isAmount(value);
}

function isLimit(value: unknown): boolean {
  return value === "unlimited" || isAmount(value);
}

function optional(item: Json, name: string, test: (value: unknown) => boolean): boolean {
  return item[name] === undefined || test(item[name]);
}

function isMeter(item: Json): boolean {
  return (
    optional(item, "used", Number.isSafeInteger) &&
    optional(item, "held", Number.isSafeInteger) &&
    optional(item, "remaining", isLimit) &&
    optional(item, "resetsAt", (value) => value === null || value instanceof Date)
  );
}

/** True for an entitlement in a list or a snapshot. @internal */
export function isEntitlement(item: unknown): boolean {
  return (
    isObject(item) &&
    typeof item.key === "string" &&
    typeof item.type === "string" &&
    typeof item.entitled === "boolean" &&
    isValue(item.value) &&
    isMeter(item)
  );
}

/** True for a check answer with every field the API documents. @internal */
export function isCheck(answer: Json): boolean {
  return (
    typeof answer.customer === "string" &&
    typeof answer.feature === "string" &&
    typeof answer.type === "string" &&
    typeof answer.entitled === "boolean" &&
    isValue(answer.value) &&
    answer.asOf instanceof Date &&
    isObject(answer.environment) &&
    isObject(answer.track) &&
    typeof answer.testers === "boolean" &&
    isMeter(answer)
  );
}
