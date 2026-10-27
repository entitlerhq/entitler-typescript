import { TokenError } from "./errors.js";
import { deadlineAfter, requireCredential, untilAborted } from "./util.js";

/**
 * A function that answers a fresh token, such as one that asks your server for a customer token.
 * The client calls it when it has no token, and once more when Entitler refuses the one it has.
 * Concurrent calls share one pending request.
 *
 * @example
 * ```ts
 * const token: TokenProvider = async ({ signal }) => {
 *   const response = await fetch("/api/entitler-token", { signal, credentials: "include" });
 *   return ((await response.json()) as { token: string }).token;
 * };
 * ```
 */
export type TokenProvider = (context: { signal: AbortSignal }) => string | Promise<string>;

/** A token kept from a fixed string or a provider. @internal */
export class TokenSource {
  readonly #provider: TokenProvider | undefined;
  readonly #timeout: number;
  readonly #closing: () => AbortSignal | undefined;
  #current: string | undefined;
  readonly #refused = new Set<string>();
  #pending: Promise<string> | undefined;

  constructor(value: string | TokenProvider, blank: string, timeout: number, closing: () => AbortSignal | undefined) {
    this.#timeout = timeout;
    this.#closing = closing;
    if (typeof value === "function") this.#provider = value;
    else this.#current = requireCredential(value, blank);
  }

  get refreshable(): boolean {
    return this.#provider !== undefined;
  }

  get(signal: AbortSignal | undefined): Promise<string> {
    return this.#current === undefined ? this.#ask(signal) : Promise.resolve(this.#current);
  }

  refuse(token: string): void {
    this.#refused.add(token);
    if (this.#current === token) this.#current = undefined;
  }

  #ask(signal: AbortSignal | undefined): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.#pending ??= this.#fetch().finally(() => {
      this.#pending = undefined;
    });
    return untilAborted(this.#pending, signal);
  }

  async #fetch(): Promise<string> {
    const timer = deadlineAfter(this.#timeout);
    const closing = this.#closing();
    const deadline = closing ? AbortSignal.any([timer, closing]) : timer;
    let answer: unknown;
    try {
      answer = await untilAborted(Promise.resolve((this.#provider as TokenProvider)({ signal: deadline })), deadline);
    } catch (cause) {
      if (closing?.aborted) throw closing.reason;
      throw new TokenError(
        timer.aborted ? `The token provider did not answer within ${this.#timeout} ms.` : "The token provider failed.",
        { cause: cause ?? new Error("The token provider rejected without a reason.") },
      );
    }
    let token: string;
    try {
      token = requireCredential(answer, "");
    } catch {
      throw new TokenError("The token provider answered a blank token, or one that can't go in a header.");
    }
    if (this.#refused.has(token)) throw new TokenError("The token provider answered a token Entitler refused.");
    this.#current = token;
    return token;
  }
}
