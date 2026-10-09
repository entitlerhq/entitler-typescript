import type { Feature } from "./types.js";

/** @internal */
export function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(message);
  return value.trim();
}

/** @internal */
export function featureKey(feature: Feature | string): string {
  const key = typeof feature === "string" ? feature : feature?.key;
  return requireText(key, "Name the feature by its key.");
}

/** @internal */
export function planKey(plan: string): string {
  return requireText(plan, "Name the plan by its id or its key.");
}

/** @internal */
export function wholeNumber(value: unknown, name: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`Pass ${name} as a whole number.`);
  }
  if (value < min || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Pass ${name} as a whole number from ${min} to ${Number.MAX_SAFE_INTEGER}.`);
  }
  return value;
}

const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,200}$/;

/** @internal */
export function idempotencyKeyOf(key: string | undefined): string {
  if (key === undefined) return crypto.randomUUID();
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
    throw new TypeError("Pass idempotencyKey as 1 to 200 printable ASCII characters.");
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
