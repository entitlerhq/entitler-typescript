import type { Feature } from "./types.js";

const SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** Trims a credential of spaces, tabs, carriage returns and line feeds. @internal */
export function trimCredential(value: string): string {
  return value.replace(SPACE, "");
}

/** Checks a credential is not blank, and trims it. @internal */
export function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || trimCredential(value) === "") throw new TypeError(message);
  return trimCredential(value);
}

/** Checks an id is not blank, keeping it exactly as given. @internal */
export function requireId(value: unknown, message: string): string {
  if (typeof value !== "string" || trimCredential(value) === "") throw new TypeError(message);
  return value;
}

/** Percent-encodes a query value or path segment as `encodeURIComponent` does. @internal */
export function encode(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError("Pass an id that is valid Unicode.");
  }
}

/** Percent-encodes one path segment, refusing ids that URL handling would turn into another route. @internal */
export function segment(value: string): string {
  const encoded = encode(value);
  if (/^\.+$/.test(value)) throw new TypeError("Pass an id that is not made only of dots.");
  return encoded;
}

/** @internal */
export function featureKey(feature: Feature | string): string {
  const key = typeof feature === "string" ? feature : feature?.key;
  return requireId(key, "Name the feature by its key.");
}

/** @internal */
export function planKey(plan: string): string {
  return requireId(plan, "Name the plan by its id or its key.");
}

/** Checks a whole number from `min` to `max`, failing with `message`. @internal */
export function wholeNumber(
  value: unknown,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
  message = `Pass ${name} as a whole number from ${min} to ${max}.`,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(message);
  if (value < min || value > max) throw new RangeError(message);
  return value;
}

/** Checks a caller's required idempotency key. @internal */
export function requiredKey(key: unknown, max = 200): string {
  if (key === undefined || key === null) {
    throw new TypeError("Pass idempotencyKey: a key from your own unit of work, such as a message or job id.");
  }
  return idempotencyKeyOf(key as string, max);
}

/** Checks a caller's idempotency key, or generates one. @internal */
export function idempotencyKeyOf(key: string | undefined, max = 200): string {
  if (key === undefined) return crypto.randomUUID();
  if (typeof key !== "string" || key.length > max || !/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(key)) {
    throw new TypeError(`Pass idempotencyKey as 1 to ${max} printable ASCII characters.`);
  }
  return key;
}

const RFC_3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** @internal */
export function instant(value: Date | string | undefined, message: string): string | undefined {
  if (value === undefined) return undefined;
  const date =
    value instanceof Date ? value : typeof value === "string" && RFC_3339.test(value) ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) throw new TypeError(message);
  return date.toISOString();
}

/** @internal */
export function compact<T extends Record<string, unknown>>(body: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== null),
  ) as Partial<T>;
}

/** @internal */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError("Not base64url.");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** @internal */
export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** @internal */
export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Reads a JWT's claims without verifying it, or `undefined` when it is not one. @internal */
export function readClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const claims = decodeJson(base64UrlDecode(parts[1]));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** @internal */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @internal */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
