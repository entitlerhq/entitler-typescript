import { type Customer, CustomerApi } from "./customer.js";
import { describe, knownScopes } from "./describe.js";
import { type ExpectedSnapshot, type VerifiedSnapshot, verifySnapshot } from "./snapshot.js";
import { principalOf, type TokenProvider, TokenSource } from "./tokens.js";
import {
  type Authorised,
  type CallOptions,
  type ClientOptions,
  type Credentials,
  Transport,
  type WriteOptions,
} from "./transport.js";
import type { RegisteredCustomer, Scopes, SnapshotKeys } from "./types.js";
import { idempotencyKeyOf, requireText } from "./util.js";
import { Visitor, visitorOf } from "./visitor.js";

/** Options both kinds of in-app client take. */
export interface InAppOptions extends ClientOptions {
  /**
   * The visitor id to send on every request, so an experiment's arm stays the same before and
   * after registration. By default a generated id, kept in a browser's `localStorage` under
   * `entitler.visitor`, or elsewhere for the client's lifetime.
   */
  visitor?: string;
}

/** Options for an in-app client built from a customer token your server minted. */
export interface TokenClientOptions extends InAppOptions {
  /** A customer token from `ServerCustomer.token()`, or a provider that fetches one from your server. */
  token: string | TokenProvider;
  /** Not taken with `token`. */
  key?: never;
  /** Not taken with `token`. */
  identityToken?: never;
}

/** Options for an in-app client built from a publishable key and a sign-in provider's identity token. */
export interface IdentityClientOptions extends InAppOptions {
  /** A publishable project key holding only product scopes. Never a secret server key. */
  key: string;
  /** The identity token your sign-in provider issued, or a provider that answers a fresh one. */
  identityToken: string | TokenProvider;
  /** Not taken with `key` and `identityToken`. */
  token?: never;
}

/** How an in-app client signs in: with a customer token, or with an identity token. */
export type ClientKind = "token" | "identity";

/**
 * The in-app client for browsers, mobile and desktop apps. It acts on one customer, the one its
 * credential names, through {@link EntitlerClient.me}.
 */
export interface EntitlerClient<K extends ClientKind = ClientKind> {
  /** `token` or `identity`. */
  readonly kind: K;
  /** The signed-in customer. */
  readonly me: Customer;
  /** The visitor id sent on every request. */
  readonly visitor: string;
  /** Registers the signed-in person as a customer. Identity-token clients only. */
  register(this: EntitlerClient<"identity">, options?: WriteOptions): Promise<RegisteredCustomer>;
  /** The scopes the credential holds and, for an identity client, whether a new person may register. */
  scopes(options?: CallOptions): Promise<Scopes>;
  /** The public keys that verify snapshots. Sends no credential. */
  snapshotKeys(options?: CallOptions): Promise<SnapshotKeys>;
  /** Verifies a snapshot offline, with no request. See {@link verifySnapshot}. */
  verifySnapshot(token: string, expected: ExpectedSnapshot): Promise<VerifiedSnapshot>;
  /** Shows the base URL and the kind, never the credential. */
  toString(): string;
  /** Shows the base URL and the kind, never the credential. */
  toJSON(): { baseUrl: string; kind: K };
}

/** Builds an {@link EntitlerClient} from a customer token, or from a publishable key and an identity token. */
export interface EntitlerClientConstructor {
  /**
   * Creates an in-app client from a customer token your server minted with `token()`.
   *
   * @example
   * ```ts
   * const client = new EntitlerClient({ token: async () => (await fetch("/api/entitler-token")).text() });
   * if (await client.me.isEntitled(features.exportPdf, { default: false })) showExport();
   * ```
   */
  new (options: TokenClientOptions): EntitlerClient<"token">;
  /** Creates an in-app client from a publishable key and a sign-in provider's identity token. */
  new (options: IdentityClientOptions): EntitlerClient<"identity">;
  /** The prototype every in-app client shares. */
  readonly prototype: EntitlerClient;
}

const WAYS_IN = "Create the client with { token } or { key, identityToken }.";

function tokenCredentials(token: TokenSource): Credentials {
  const signed = (value: string): Authorised => ({
    headers: { Authorization: `Bearer ${value}` },
    principal: principalOf(value, ["iss", "eid", "sub"]),
    token: value,
  });
  return {
    kind: "token",
    authorise: async (signal) => signed(await token.get(signal)),
    ...(token.refreshable
      ? { refresh: async (used: Authorised, signal) => signed(await token.refresh(used.token as string, signal)) }
      : {}),
  };
}

function identityCredentials(key: string, identity: TokenSource): Credentials {
  const signed = (value: string): Authorised => ({
    headers: { Authorization: `Bearer ${key}`, "Entitler-Identity-Token": value },
    principal: `key:${key}:${principalOf(value, ["iss", "sub"])}`,
    token: value,
  });
  return {
    kind: "identity",
    authorise: async (signal) => signed(await identity.get(signal)),
    ...(identity.refreshable
      ? { refresh: async (used: Authorised, signal) => signed(await identity.refresh(used.token as string, signal)) }
      : {}),
  };
}

class InAppClient {
  readonly #transport: Transport;
  readonly #visitor: Visitor;
  readonly me: Customer;

  constructor(options: TokenClientOptions | IdentityClientOptions) {
    const { token, key, identityToken } = (options ?? {}) as Partial<TokenClientOptions & IdentityClientOptions>;
    const byToken = token !== undefined;
    if (
      byToken === (key !== undefined || identityToken !== undefined) ||
      (!byToken && (key === undefined || identityToken === undefined))
    ) {
      throw new TypeError(WAYS_IN);
    }
    const credentials = byToken
      ? tokenCredentials(new TokenSource(token, "Provide a customer token minted by your server."))
      : identityCredentials(
          requireText(key, "Provide an Entitler API key from the dashboard."),
          new TokenSource(
            identityToken as string | TokenProvider,
            "Provide the identity token your sign-in provider issued.",
          ),
        );
    const visitor = new Visitor(visitorOf(options.visitor));
    this.#visitor = visitor;
    this.#transport = new Transport(options, credentials, () => ({ "Entitler-Visitor": visitor.sent() }));
    this.me = new CustomerApi(this.#transport, undefined);
  }

  get kind(): ClientKind {
    return this.#transport.kind as ClientKind;
  }

  get visitor(): string {
    return this.#visitor.id;
  }

  async register(options?: WriteOptions): Promise<RegisteredCustomer> {
    if (this.kind !== "identity") {
      throw new TypeError("Register with an identity-token client; a customer token names a registered customer.");
    }
    const answer = await this.#transport.send<RegisteredCustomer>({
      method: "PUT",
      path: "/customers/me",
      idempotencyKey: idempotencyKeyOf(options?.idempotencyKey),
      customer: "/customers/me",
      options,
    });
    return answer.data;
  }

  async scopes(options?: CallOptions): Promise<Scopes> {
    const answer = await this.#transport.send<{ scopes: string[]; registration?: boolean }>({
      method: "GET",
      path: "/keys/self",
      options,
    });
    const scopes = knownScopes(answer.data.scopes);
    return this.kind === "identity" && typeof answer.data.registration === "boolean"
      ? { scopes, registration: answer.data.registration }
      : { scopes };
  }

  async snapshotKeys(options?: CallOptions): Promise<SnapshotKeys> {
    return (
      await this.#transport.send<SnapshotKeys>({ method: "GET", path: "/customers/snapshot-keys", open: true, options })
    ).data;
  }

  async verifySnapshot(token: string, expected: ExpectedSnapshot): Promise<VerifiedSnapshot> {
    return verifySnapshot(token, expected);
  }

  toString(): string {
    return describe("EntitlerClient", this.#transport);
  }

  toJSON(): { baseUrl: string; kind: ClientKind } {
    return { baseUrl: this.#transport.baseUrl, kind: this.kind };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * The in-app client. Build it with `{ token }` (a customer token from your server, or a
 * provider for one) or with `{ key, identityToken }` (a publishable key holding only product
 * scopes, and your sign-in provider's identity token). A secret server key never goes into an
 * app: anyone can read it out of a bundle or binary and act on every customer.
 */
export const EntitlerClient: EntitlerClientConstructor = InAppClient as unknown as EntitlerClientConstructor;
