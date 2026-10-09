import { TokenError } from "./errors.js";
import { readClaims, requireText } from "./util.js";

/**
 * A function that answers a fresh token, such as one that asks your server for a customer
 * token. The client calls it for the first request, again when the kept token expires within
 * 60 seconds (or half its lifetime, when shorter), and once after a `401`. Concurrent calls share
 * one pending refresh.
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
  #receivedAt = 0;
  #pending: Promise<string> | undefined;

  readonly #timeout: number;

  constructor(value: string | TokenProvider, blankMessage: string, timeout = 10_000) {
    this.#timeout = timeout;
    if (typeof value === "function") this.#provider = value;
    else this.#current = requireText(value, blankMessage);
  }

  get refreshable(): boolean {
    return this.#provider !== undefined;
  }

  async get(signal: AbortSignal | undefined): Promise<string> {
    const current = this.#current;
    if (current !== undefined && (!this.#provider || !expiresSoon(current, this.#receivedAt))) return current;
    return this.#refresh(signal);
  }

  async refresh(used: string, signal: AbortSignal | undefined): Promise<string> {
    if (this.#current !== undefined && this.#current !== used) return this.#current;
    return this.#refresh(signal);
  }

  #refresh(signal: AbortSignal | undefined): Promise<string> {
    this.#pending ??= this.#ask().finally(() => {
      this.#pending = undefined;
    });
    return abortable(this.#pending, signal);
  }

  async #ask(): Promise<string> {
    const deadline = AbortSignal.timeout(this.#timeout);
    let answer: unknown;
    try {
      answer = await abortable(Promise.resolve((this.#provider as TokenProvider)({ signal: deadline })), deadline);
    } catch (cause) {
      throw new TokenError(
        deadline.aborted
          ? `The token provider did not answer within ${this.#timeout} ms.`
          : "The token provider failed.",
        { cause },
      );
    }
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new TokenError("The token provider answered a blank token.");
    }
    const token = answer.trim();
    if (!readClaims(token)) throw new TokenError("The token provider answered a token that is not a readable JWT.");
    this.#current = token;
    this.#receivedAt = Date.now();
    return token;
  }
}

function expiresSoon(token: string, receivedAt: number): boolean {
  const claims = readClaims(token);
  if (typeof claims?.exp !== "number") return false;
  const expiresAt = claims.exp * 1000;
  const issuedAt = typeof claims.iat === "number" ? claims.iat * 1000 : receivedAt;
  return expiresAt - Date.now() < Math.min(REFRESH_BEFORE_MS, (expiresAt - issuedAt) / 2);
}
