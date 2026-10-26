import type { Feature } from "./types.js";

const SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** Trims a credential of spaces, tabs, carriage returns and line feeds. @internal */
export function trimCredential(value: string): string {
  return value.replace(SPACE, "");
}

/** True for a trimmed credential every character of which lies from `!` to `~`, so it is safe in a header. @internal */
export function headerSafe(credential: string): boolean {
  return /^[\x21-\x7e]+$/.test(credential);
}

/** Checks a credential is not blank and holds only `!` to `~` once trimmed, failing as blank otherwise, and trims it. @internal */
export function requireCredential(value: unknown, message: string): string {
  const trimmed = typeof value === "string" ? trimCredential(value) : "";
  if (!headerSafe(trimmed)) throw new TypeError(message);
  return trimmed;
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
  if (typeof key !== "string" || key.length > max || !/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(key)) {
    throw new TypeError(`Pass idempotencyKey as 1 to ${max} printable ASCII characters.`);
  }
  return key;
}

/** @internal */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const LONGEST_TIMER = 2_147_483_647;
const HIDDEN = "[hidden by Entitler: holds a credential]";

/** Hides a value that holds a credential from its string forms: `String`, `JSON.stringify` and `util.inspect`. @internal */
export function redacted<T extends object>(value: T): T {
  const hide = { value: () => HIDDEN, enumerable: false, configurable: true };
  return Object.defineProperties(value, {
    toString: hide,
    toJSON: hide,
    [Symbol.for("nodejs.util.inspect.custom")]: hide,
  });
}

/** A summary of a library's error, its message and its cause's, keeping no reference to anything it held. @internal */
export function summaryOf(error: unknown): Error {
  const describe = (value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}` : typeof value === "string" ? value : "";
  const cause = error instanceof Error ? describe(error.cause) : "";
  return new Error(`${describe(error) || "An unknown failure"}${cause ? ` (${cause})` : ""}`);
}

/** A whole number read from digits, saturating at the largest safe integer however many digits there are. @internal */
export function saturated(digits: string): number {
  return Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
}

/** A duration in milliseconds clamped to what timers can represent, so it never overflows into 0. @internal */
export function timerDelay(ms: number): number {
  return Math.min(Math.max(0, ms), LONGEST_TIMER);
}

/** An `AbortSignal` that aborts after `ms`, clamped to what timers can represent. @internal */
export function deadlineAfter(ms: number): AbortSignal {
  return AbortSignal.timeout(timerDelay(ms));
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
    }, timerDelay(ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Answers `promise`, or rejects with the signal's reason once it aborts. @internal */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
