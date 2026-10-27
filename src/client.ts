import { MemoryCache } from "./cache.js";
import { type Customer, CustomerApi } from "./customer.js";
import { type ClientDescription, describe } from "./describe.js";
import { type TokenProvider, TokenSource } from "./tokens.js";
import { type Authorised, type CallOptions, type ClientOptions, type Credentials, Transport } from "./transport.js";
import type { RegisteredCustomer } from "./types.js";
import { requireCredential } from "./util.js";

/** Options every in-app client takes. */
export interface InAppOptions extends ClientOptions {
  /**
   * The in-memory answer cache: a {@link MemoryCache} of another size, or `false` for none. Defaults
   * to a {@link MemoryCache} of 1,000 answers. An app's answers belong to one signed-in customer, so
   * they are never kept in a shared or lasting store.
   */
  cache?: MemoryCache | false;
}

/** Options for an in-app client built from a customer token your server minted. */
export interface TokenClientOptions extends InAppOptions {
  /** A customer token from `ServerCustomer.token()`, or a provider that asks your server for one. */
  token: string | TokenProvider;
  /** Not taken with `token`. */
  key?: never;
  /** Not taken with `token`. */
  identityToken?: never;
}

/** Options for an in-app client built from a publishable key and a sign-in provider's identity token. */
export interface IdentityClientOptions extends InAppOptions {
  /** A publishable key from the dashboard. Never a secret key, which belongs on your servers. */
  key: string;
  /** The identity token your sign-in provider issued, or a provider that answers a fresh one. */
  identityToken: string | TokenProvider;
  /** Not taken with `key` and `identityToken`. */
  token?: never;
}

/** How an in-app client signs in: with a customer token, or with a publishable key and an identity token. */
export type ClientKind = "token" | "identity";

const WAYS_IN = "Create the client with { token } or { key, identityToken }.";
const CUSTOM_STORE = "In-app clients keep answers in memory: pass a MemoryCache of another size, or false.";

function credentials(kind: ClientKind, source: TokenSource, key?: string): Credentials {
  const signed = (token: string): Authorised =>
    key === undefined
      ? { headers: { Authorization: `Bearer ${token}` }, kind: "customer-token", credential: token, token }
      : {
          headers: { Authorization: `Bearer ${key}`, "Entitler-Identity-Token": token },
          kind: "identity",
          credential: `${key}\n${token}`,
          token,
        };
  return {
    kind,
    authorise: async (signal) => signed(await source.get(signal)),
    ...(source.refreshable ? { refuse: (used) => source.refuse(used.token as string) } : {}),
  };
}

/**
 * The in-app client for browsers, mobile and desktop apps, for one signed-in customer. Build it with
 * `{ token }`, a customer token from your server or a provider for one, or with `{ key, identityToken }`,
 * a publishable key and your sign-in provider's identity token. Keep one per signed-in customer, and
 * close it at sign-out.
 *
 * @example
 * ```ts
 * const entitler = new EntitlerClient({
 *   token: async ({ signal }) => {
 *     const response = await fetch("/api/entitler-token", { signal, credentials: "include" });
 *     return ((await response.json()) as { token: string }).token;
 *   },
 * });
 * if (await entitler.me.isEntitled("export_pdf", { default: false })) showExport();
 * ```
 */
export class EntitlerClient {
  /** The signed-in customer. */
  readonly me: Customer;
  readonly #transport: Transport;
  readonly #me: CustomerApi;

  /** Creates an in-app client. Throws `TypeError` for missing or mixed credentials. */
  constructor(options: TokenClientOptions | IdentityClientOptions) {
    const { token, key, identityToken, cache } = (options ?? {}) as Partial<TokenClientOptions & IdentityClientOptions>;
    const byToken = token !== undefined;
    if (byToken ? key !== undefined || identityToken !== undefined : key === undefined || identityToken === undefined) {
      throw new TypeError(WAYS_IN);
    }
    if (cache !== undefined && cache !== false && !((cache as unknown) instanceof MemoryCache))
      throw new TypeError(CUSTOM_STORE);
    let transport: Transport | undefined;
    const closing = () => transport?.closing;
    const timeout = options.timeout ?? 10_000;
    const signIn = byToken
      ? credentials(
          "token",
          new TokenSource(token, "Provide a customer token minted by your server.", timeout, closing),
        )
      : credentials(
          "identity",
          new TokenSource(
            identityToken as string | TokenProvider,
            "Provide the identity token your sign-in provider issued.",
            timeout,
            closing,
          ),
          requireCredential(key, "Provide a publishable key from the dashboard."),
        );
    transport = new Transport(options, signIn);
    this.#transport = transport;
    this.#me = new CustomerApi(transport, "me");
    this.me = this.#me;
  }

  /** `token` or `identity`. */
  get kind(): ClientKind {
    return this.#transport.kind as ClientKind;
  }

  /**
   * Registers the signed-in person as a customer. Call it after each sign-in: a customer registered
   * already is answered as they are. Answers `PermissionDenied` when the sign-in provider doesn't let
   * people register themselves.
   */
  register(options?: CallOptions): Promise<RegisteredCustomer> {
    return this.#me.register(options);
  }

  /**
   * Closes the client at sign-out: aborts every call in flight and the pending token request, drops
   * the in-memory cache, and makes every later call reject with a `DOMException` named
   * `InvalidStateError`. Closing twice is safe.
   */
  close(): void {
    this.#transport.close();
  }

  /** Shows the base URL and the kind, never the credential. */
  toString(): string {
    return describe("EntitlerClient", this.#transport);
  }

  /** Shows the base URL and the kind, never the credential. */
  toJSON(): ClientDescription<ClientKind> {
    return { baseUrl: this.#transport.baseUrl, kind: this.kind };
  }

  /** Shows the base URL and the kind in Node's `console.log`, never the credential. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
