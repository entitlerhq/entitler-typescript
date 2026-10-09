import { base64UrlEncode } from "./util.js";

/** What a visitor id looks like: 16 to 64 letters, numbers, hyphens or underscores. */
export const VISITOR_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{16,64}$/;

const STORAGE_KEY = "entitler.visitor";

/**
 * Mints a new visitor id: 24 cryptographically random bytes, base64url without padding. On a
 * server, keep it for the visitor, for example in a first-party cookie, and pass it to
 * `pricing({ visitor })` and `register({ visitor })`, so the same person sees the same
 * experiment arm on every page and after signing up.
 */
export function newVisitorId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

/** @internal */
export function visitorOf(visitor: unknown): string | undefined {
  if (visitor === undefined) return undefined;
  if (typeof visitor !== "string" || !VISITOR_ID_PATTERN.test(visitor)) {
    throw new TypeError("Pass visitor as an id of 16 to 64 letters, numbers, hyphens or underscores.");
  }
  return visitor;
}

function storage(): Storage | undefined {
  const g = globalThis as { document?: unknown; localStorage?: Storage };
  if (g.document === undefined) return undefined;
  try {
    return g.localStorage;
  } catch {
    return undefined;
  }
}

/** The in-app client's visitor: given, kept in a browser's `localStorage`, or for the client's lifetime. @internal */
export class Visitor {
  readonly id: string;
  #unsaved: boolean;

  constructor(given: string | undefined) {
    if (given !== undefined) {
      this.id = given;
      this.#unsaved = false;
      return;
    }
    let stored: string | null | undefined;
    try {
      stored = storage()?.getItem(STORAGE_KEY);
    } catch {
      stored = undefined;
    }
    this.#unsaved = !(stored && VISITOR_ID_PATTERN.test(stored));
    this.id = this.#unsaved ? newVisitorId() : (stored as string);
  }

  sent(): string {
    if (this.#unsaved) {
      this.#unsaved = false;
      try {
        storage()?.setItem(STORAGE_KEY, this.id);
      } catch {
        return this.id;
      }
    }
    return this.id;
  }
}
