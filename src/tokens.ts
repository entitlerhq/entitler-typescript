import { TokenError } from "./errors.js";
import { readClaims, requireText } from "./util.js";

/**
 * A function that answers a fresh token, such as one that asks your server for a customer
 * token. The client calls it for the first request, again when the kept token expires within
 * 60 seconds, and once after a `401`. Concurrent calls share one pending refresh.
 *
 * @example
 * ```ts
 * const token: TokenProvider = async ({ signal }) => {
 *   const response = await fetch("/api/entitler-token", { signal });
 *   return (await response.json()).token;
 * };
 * ```
 */
export type TokenProvider = (context: { signal: AbortSignal }) => string | Promise<string>;

const REFRESH_BEFORE_MS = 60_000;
const NEVER = new AbortController().signal;

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A token kept from a fixed string or a provider. @internal */
export class TokenSource {
  readonly #provider: TokenProvider | undefined;
  #current: string | undefined;
  #pending: Promise<string> | undefined;

  constructor(value: string | TokenProvider, blankMessage: string) {
    if (typeof value === "function") this.#provider = value;
    else this.#current = requireText(value, blankMessage);
  }

  get refreshable(): boolean {
    return this.#provider !== undefined;
  }

  async get(signal: AbortSignal | undefined): Promise<string> {
    const current = this.#current;
    if (current !== undefined && (!this.#provider || !expiresSoon(current))) return current;
    return this.#refresh(signal);
  }

  async refresh(used: string, signal: AbortSignal | undefined): Promise<string> {
    if (this.#current !== undefined && this.#current !== used) return this.#current;
    return this.#refresh(signal);
  }

  #refresh(signal: AbortSignal | undefined): Promise<string> {
    this.#pending ??= this.#ask(signal).finally(() => {
      this.#pending = undefined;
    });
    return abortable(this.#pending, signal);
  }

  async #ask(signal: AbortSignal | undefined): Promise<string> {
    let answer: unknown;
    try {
      answer = await (this.#provider as TokenProvider)({ signal: signal ?? NEVER });
    } catch (cause) {
      if (signal?.aborted && cause === signal.reason) throw cause;
      throw new TokenError("The token provider failed.", { cause });
    }
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new TokenError("The token provider answered a blank token.");
    }
    const token = answer.trim();
    if (!readClaims(token)) throw new TokenError("The token provider answered a token that is not a readable JWT.");
    this.#current = token;
    return token;
  }
}

function expiresSoon(token: string): boolean {
  const exp = readClaims(token)?.exp;
  return typeof exp === "number" && exp * 1000 - Date.now() < REFRESH_BEFORE_MS;
}

/** The claims that name a token's customer, for keying cached answers. @internal */
export function principalOf(token: string, names: readonly string[]): string {
  const claims = readClaims(token);
  return claims ? JSON.stringify(names.map((name) => claims[name] ?? null)) : `token:${token}`;
}
