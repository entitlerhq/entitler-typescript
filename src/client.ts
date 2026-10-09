import { MemoryCache } from "./cache.js";
import { type Customer, CustomerApi, type PricingOptions } from "./customer.js";
import { type ClientDescription, describe, knownScopes } from "./describe.js";
import { type SnapshotExpectation, type VerifiedSnapshot, verifySnapshot } from "./snapshot.js";
import { type TokenProvider, TokenSource } from "./tokens.js";
import {
  type Authorised,
  type CallOptions,
  type ClientOptions,
  type Credentials,
  Transport,
  type WriteOptions,
} from "./transport.js";
import type { Pricing, RegisteredCustomer, Scopes, SnapshotKeys } from "./types.js";
import { idempotencyKeyOf, requireText, trimCredential } from "./util.js";
import { Visitor, visitorOf } from "./visitor.js";

/** Options every in-app client takes. */
export interface InAppOptions extends ClientOptions {
  /**
   * The visitor id to send on every request, so an experiment's arm stays the same before and
   * after registration. By default a generated id, kept in a browser's `localStorage` under
   * `entitler.visitor`, or elsewhere for the client's lifetime.
   */
  visitor?: string;
  /**
   * The in-memory answer cache: a {@link MemoryCache} of another size, or `false` for none.
   * Defaults to a {@link MemoryCache} of 1,000 answers. An in-app client's principal changes with
   * every token, so it takes no shared or persisted store: only snapshots survive a relaunch.
   */
  cache?: MemoryCache | false;
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
  /** A publishable key (`ent_pk_…`), which holds product scopes only. Never a secret server key. */
  key: string;
  /** The identity token your sign-in provider issued, or a provider that answers a fresh one. */
  identityToken: string | TokenProvider;
  /** Not taken with `key` and `identityToken`. */
  token?: never;
}

/** Options for a signed-out in-app client built from a publishable key alone, for a paywall or pricing page. */
export interface PublishableClientOptions extends InAppOptions {
  /** A publishable key (`ent_pk_…`), which holds product scopes only. Never a secret server key. */
  key: string;
  /** Not taken with a publishable key alone. */
  identityToken?: never;
  /** Not taken with a publishable key alone. */
  token?: never;
}

/** How an in-app client was built: with a customer token, an identity token, or a publishable key alone. */
export type ClientKind = "token" | "identity" | "publishable";

/** What every in-app client has, whatever its credential. */
export interface InAppClientBase<K extends ClientKind> {
  /** `token`, `identity` or `publishable`. */
  readonly kind: K;
  /** The visitor id sent on every request. */
  readonly visitor: string;
  /** The public keys that verify snapshots. Sends no credential. */
  snapshotKeys(options?: CallOptions): Promise<SnapshotKeys>;
  /** Verifies a snapshot offline, with no request. See {@link verifySnapshot}. */
  verifySnapshot(token: string, expected: SnapshotExpectation): Promise<VerifiedSnapshot>;
  /**
   * Closes the client at sign-out: aborts every call in flight and the pending token refresh,
   * drops the in-memory cache, and makes every later call reject with a `DOMException` named
   * `InvalidStateError`. Closing twice is safe.
   */
  close(): void;
  /** Shows the base URL and the kind, never the credential. */
  toString(): string;
  /** Shows the base URL and the kind, never the credential. */
  toJSON(): ClientDescription<K>;
}

/** An in-app client for one signed-in customer, built from a customer token or an identity token. */
export interface SignedInClient<K extends "token" | "identity"> extends InAppClientBase<K> {
  /** The signed-in customer. */
  readonly me: Customer;
  /**
   * Registers the signed-in person as a customer: call it after each sign-in, since an existing
   * customer is answered without being created again. Identity-token clients only. Answers
   * `403 registration_closed` when the sign-in provider does not let people register themselves.
   */
  register(this: SignedInClient<"identity">, options?: WriteOptions): Promise<RegisteredCustomer>;
  /** The scopes the credential holds and, for an identity client, whether a new person may register. */
  scopes(options?: CallOptions): Promise<Scopes>;
}

/** A signed-out in-app client built from a publishable key alone, for a paywall or pricing page. */
export interface PublishableClient extends InAppClientBase<"publishable"> {
  /** The pricing on sale, signed out, with the client's visitor, through the answer cache. */
  pricing(options?: PricingOptions): Promise<Pricing>;
}

/**
 * The in-app client for browsers, mobile and desktop apps: a {@link SignedInClient} for one
 * signed-in customer, or a {@link PublishableClient} for signed-out pricing. Keep one per
 * signed-in customer where the app keeps its session state, and close it at sign-out.
 */
export type EntitlerClient<K extends ClientKind = ClientKind> = K extends "publishable"
  ? PublishableClient
  : K extends "token" | "identity"
    ? SignedInClient<K>
    : never;

/** Builds an {@link EntitlerClient} from a customer token, from a publishable key and an identity token, or from a publishable key alone. */
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
  /**
   * Creates a signed-out in-app client from a publishable key alone, for a paywall or pricing page.
   *
   * @example
   * ```ts
   * const client = new EntitlerClient({ key: "ent_pk_live_…" });
   * const pricing = await client.pricing();
   * ```
   */
  new (options: PublishableClientOptions): EntitlerClient<"publishable">;
  /** The prototype every in-app client shares. */
  readonly prototype: EntitlerClient;
}

const WAYS_IN = "Create the client with { token }, { key, identityToken } or { key }.";
const SIGN_IN = "Sign the customer in first: create the client with { token } or { key, identityToken }.";
const SECRET_KEY =
  "A secret key belongs on your server, in EntitlerServer. Use a publishable key (ent_pk_…) in an app.";
const CUSTOM_STORE = "In-app clients keep answers in memory: pass a cache size, or turn the cache off.";

function tokenCredentials(token: TokenSource): Credentials {
  const signed = (value: string): Authorised => ({
    headers: { Authorization: `Bearer ${value}` },
    kind: "customer-token",
    credential: value,
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
    kind: "identity",
    credential: `${key}\n${value}`,
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

function publishableCredentials(key: string): Credentials {
  const authorised: Authorised = { headers: { Authorization: `Bearer ${key}` }, kind: "key", credential: key };
  return { kind: "publishable", authorise: async () => authorised };
}

class InAppClient {
  readonly #transport: Transport;
  readonly #visitor: Visitor;
  readonly #me: Customer | undefined;

  constructor(options: TokenClientOptions | IdentityClientOptions | PublishableClientOptions) {
    const { token, key, identityToken, cache } = (options ?? {}) as Partial<TokenClientOptions & IdentityClientOptions>;
    const byToken = token !== undefined;
    if (byToken ? key !== undefined || identityToken !== undefined : key === undefined) throw new TypeError(WAYS_IN);
    const timeout = options.timeout;
    let transport: Transport | undefined;
    const closing = () => transport?.closing;
    let credentials: Credentials;
    if (byToken) {
      credentials = tokenCredentials(
        new TokenSource(token, "Provide a customer token minted by your server.", timeout, closing),
      );
    } else {
      const publishable = trimCredential(requireText(key, "Provide an Entitler API key from the dashboard."));
      const identity =
        identityToken === undefined
          ? undefined
          : new TokenSource(
              identityToken,
              "Provide the identity token your sign-in provider issued.",
              timeout,
              closing,
            );
      if (!publishable.startsWith("ent_pk_")) throw new TypeError(SECRET_KEY);
      credentials = identity ? identityCredentials(publishable, identity) : publishableCredentials(publishable);
    }
    if (cache !== undefined && cache !== false && !((cache as unknown) instanceof MemoryCache)) {
      throw new TypeError(CUSTOM_STORE);
    }
    const visitor = new Visitor(visitorOf(options.visitor));
    this.#visitor = visitor;
    transport = new Transport(options, credentials, () => ({ "Entitler-Visitor": visitor.sent() }));
    this.#transport = transport;
    this.#me = credentials.kind === "publishable" ? undefined : new CustomerApi(transport, undefined);
  }

  get kind(): ClientKind {
    return this.#transport.kind as ClientKind;
  }

  get visitor(): string {
    return this.#visitor.id;
  }

  get me(): Customer {
    if (!this.#me) throw new TypeError(SIGN_IN);
    return this.#me;
  }

  async register(options?: WriteOptions): Promise<RegisteredCustomer> {
    if (this.kind === "publishable") throw new TypeError(SIGN_IN);
    const answer = await this.#transport.send<RegisteredCustomer>({
      method: "PUT",
      path: "/customers/me",
      idempotencyKey: idempotencyKeyOf(options?.idempotencyKey),
      changes: ["/customers/me"],
      options,
    });
    return { ...answer.data, replayed: answer.replayed };
  }

  async scopes(options?: CallOptions): Promise<Scopes> {
    if (this.kind === "publishable") throw new TypeError(SIGN_IN);
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

  async pricing(options?: PricingOptions): Promise<Pricing> {
    if (this.kind !== "publishable") throw new TypeError("Read the signed-in customer's pricing with me.pricing().");
    const answer = await this.#transport.send<Pricing>({
      method: "GET",
      path: "/pricing",
      cached: true,
      revalidate: options?.revalidate,
      headers: { "Entitler-Visitor": visitorOf(options?.visitor) },
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  async snapshotKeys(options?: CallOptions): Promise<SnapshotKeys> {
    return (
      await this.#transport.send<SnapshotKeys>({ method: "GET", path: "/customers/snapshot-keys", open: true, options })
    ).data;
  }

  async verifySnapshot(token: string, expected: SnapshotExpectation): Promise<VerifiedSnapshot> {
    return verifySnapshot(token, expected);
  }

  close(): void {
    this.#transport.close();
  }

  toString(): string {
    return describe("EntitlerClient", this.#transport);
  }

  toJSON(): ClientDescription<ClientKind> {
    return { baseUrl: this.#transport.baseUrl, kind: this.kind };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * The in-app client. Build it with `{ token }` (a customer token from your server, or a provider
 * for one), with `{ key, identityToken }` (a publishable key and your sign-in provider's identity
 * token), or with `{ key }` alone for signed-out pricing. A secret server key never goes into an
 * app: anyone can read it out of a bundle or binary and act on every customer, so the client
 * refuses one, failing on the developer's machine rather than in a shipped app.
 */
export const EntitlerClient: EntitlerClientConstructor = InAppClient as unknown as EntitlerClientConstructor;
