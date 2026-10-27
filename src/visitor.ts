import { MemoryCache } from "./cache.js";
import { type ClientDescription, describe } from "./describe.js";
import { features, type PricingOptions, pricing } from "./pricing.js";
import { snapshotKeys } from "./snapshot.js";
import { type CallOptions, type ClientOptions, type ReadOptions, Transport } from "./transport.js";
import type { FeatureList, PricingSheet, SnapshotKeySet } from "./types.js";
import { requireCredential } from "./util.js";

/** Options for {@link EntitlerVisitor}. */
export interface VisitorOptions extends ClientOptions {
  /** A publishable key from the dashboard. It is safe to ship in an app or a web page. */
  key: string;
  /** The in-memory answer cache: a {@link MemoryCache} of another size, or `false` for none. Defaults to a {@link MemoryCache}. */
  cache?: MemoryCache | false;
}

/**
 * The visitor client, built from a publishable key, for a page or app with no signed-in customer:
 * a pricing page, say.
 *
 * @example
 * ```ts
 * const entitler = new EntitlerVisitor({ key: "pk_live_…" });
 * const sheet = await entitler.pricing({ country: "AU", locale: navigator.language });
 * ```
 */
export class EntitlerVisitor {
  readonly #transport: Transport;

  /** Creates a visitor client. Throws `TypeError` for a blank key. */
  constructor(options: VisitorOptions) {
    const key = requireCredential(options?.key, "Provide a publishable key from the dashboard.");
    if (
      options.cache !== undefined &&
      options.cache !== false &&
      !((options.cache as unknown) instanceof MemoryCache)
    ) {
      throw new TypeError("Visitor clients keep answers in memory: pass a MemoryCache of another size, or false.");
    }
    this.#transport = new Transport(options, {
      kind: "visitor",
      authorise: async () => ({ headers: { Authorization: `Bearer ${key}` }, kind: "key", credential: key }),
    });
  }

  /**
   * Reads the plans on sale on the default track, priced in `market`, or in `country`'s market.
   * With neither, the plans come with no prices.
   */
  pricing(options?: PricingOptions): Promise<PricingSheet> {
    return pricing(this.#transport, options);
  }

  /** Reads the catalogue's features served on the default track, archived ones included. */
  features(options?: ReadOptions): Promise<FeatureList> {
    return features(this.#transport, options);
  }

  /** Fetches the public keys that verify snapshots, sending no credential. */
  snapshotKeys(options?: CallOptions): Promise<SnapshotKeySet> {
    return snapshotKeys(this.#transport, options);
  }

  /** Closes the client: aborts every call in flight, drops the in-memory cache, and makes every later call reject. */
  close(): void {
    this.#transport.close();
  }

  /** Shows the base URL and the kind, never the key. */
  toString(): string {
    return describe("EntitlerVisitor", this.#transport);
  }

  /** Shows the base URL and the kind, never the key. */
  toJSON(): ClientDescription<"visitor"> {
    return { baseUrl: this.#transport.baseUrl, kind: "visitor" };
  }

  /** Shows the base URL and the kind in Node's `console.log`, never the key. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
