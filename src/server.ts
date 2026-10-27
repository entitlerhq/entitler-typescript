import type { CacheStore } from "./cache.js";
import { CustomerApi, type ServerCustomer } from "./customer.js";
import { type ClientDescription, describe } from "./describe.js";
import { snapshotKeys } from "./snapshot.js";
import { type CallOptions, type ClientOptions, Transport } from "./transport.js";
import type { SnapshotKeySet } from "./types.js";
import { requireCredential, requireId } from "./util.js";

/** Options for {@link EntitlerServer}. */
export interface ServerOptions extends ClientOptions {
  /** A secret key from the dashboard. Keep it on your servers; never ship it in an app. */
  key: string;
  /**
   * Where to keep answers: a {@link MemoryCache} of another size, any {@link CacheStore} (Workers KV,
   * Redis) to share answers between processes, or `false` for none. Defaults to a
   * {@link MemoryCache} of 1,000 answers.
   */
  cache?: CacheStore | false;
}

/**
 * The server client, built from a secret key. It runs on your servers and acts on any customer.
 *
 * @example
 * ```ts
 * const entitler = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
 * const customer = entitler.customer("ada");
 * if (await customer.isEntitled("priority_support", { default: false })) openTicket();
 * ```
 */
export class EntitlerServer {
  readonly #transport: Transport;

  /** Creates a server client. Throws `TypeError` for a blank key. */
  constructor(options: ServerOptions) {
    const key = requireCredential(options?.key, "Provide an Entitler key from the dashboard.");
    this.#transport = new Transport(options, {
      kind: "server",
      authorise: async () => ({ headers: { Authorization: `Bearer ${key}` }, kind: "key", credential: key }),
    });
  }

  /** The customer with the id your app uses for them. Makes no request. */
  customer(id: string): ServerCustomer {
    const given = requireId(id, "Provide the id your app uses for the customer.");
    if (given === "me") throw new TypeError("me names the signed-in customer, which only an app's client has.");
    return new CustomerApi(this.#transport, given);
  }

  /**
   * Fetches the public keys that verify snapshots, sending no credential. Ship them with your app
   * so it can call `verifySnapshot` offline.
   */
  snapshotKeys(options?: CallOptions): Promise<SnapshotKeySet> {
    return snapshotKeys(this.#transport, options);
  }

  /**
   * Closes the client: aborts every call in flight, drops the in-memory cache (a custom store is
   * left as it is), and makes every later call reject with a `DOMException` named
   * `InvalidStateError`. Closing twice is safe.
   */
  close(): void {
    this.#transport.close();
  }

  /** Shows the base URL and the kind, never the key. */
  toString(): string {
    return describe("EntitlerServer", this.#transport);
  }

  /** Shows the base URL and the kind, never the key. */
  toJSON(): ClientDescription<"server"> {
    return { baseUrl: this.#transport.baseUrl, kind: "server" };
  }

  /** Shows the base URL and the kind in Node's `console.log`, never the key. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
