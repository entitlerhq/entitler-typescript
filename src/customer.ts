import { Entitlements, type EntitlementsInit } from "./entitlements.js";
import { type Operation, route } from "./routes.js";
import { type Decoder, decodeCheck, decodeEntitlements } from "./shapes.js";
import { isClosed, type ReadOptions, type Transport } from "./transport.js";
import type { Check, Feature, FeatureType } from "./types.js";
import { featureKey } from "./util.js";

/** Options for a customer's reads. */
export interface CheckOptions extends ReadOptions {
  /**
   * Answers as of this instant instead of now, in a test environment whose plan allows the test
   * clock. A live environment refuses it with `AS_OF_NOT_ALLOWED`.
   */
  asOf?: Date;
}

/** Options for {@link Customer.isEntitled}. */
export interface IsEntitledOptions extends CheckOptions {
  /**
   * The answer when Entitler cannot be asked. Pass `false` for paid features (fail closed), and
   * `true` only where losing a sale is worse than giving the feature away (fail open).
   */
  default: boolean;
}

/** A customer, named by the id your app uses for them. */
export interface Customer {
  /** The id your app uses for the customer. */
  readonly id: string;
  /**
   * Checks one feature: Entitler's decision, the value, the meter for a metered feature, where the
   * value comes from and the plans that would give it.
   *
   * @example
   * ```ts
   * const check = await customer.check("ai_credits");
   * if (!check.entitled) showUpgrade(check.upgrades);
   * ```
   */
  check<T extends FeatureType>(feature: Feature<T>, options?: CheckOptions): Promise<Check<T>>;
  /** Checks one feature by its key. */
  check(feature: string, options?: CheckOptions): Promise<Check>;
  /**
   * Answers Entitler's decision for one feature, or `default` when Entitler cannot be asked. Never
   * throws for a failed request; only a cancelled or closed call rejects.
   */
  isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean>;
  /** Lists every entitlement the customer holds, groups included. */
  entitlements(options?: CheckOptions): Promise<Entitlements>;
}

function asOf(options: CheckOptions | undefined): Record<string, string | undefined> {
  const given = options?.asOf;
  if (given === undefined) return {};
  if (!(given instanceof Date) || Number.isNaN(given.getTime())) throw new TypeError("Pass asOf as a valid date.");
  return { as_of: String(Math.floor(given.getTime() / 1000)) };
}

/** A customer's methods over the transport. @internal */
export class CustomerApi implements Customer {
  readonly id: string;
  readonly #transport: Transport;

  constructor(transport: Transport, id: string) {
    this.#transport = transport;
    this.id = id;
  }

  async #cached<T>(
    operation: Operation,
    variables: Record<string, string>,
    options: CheckOptions | undefined,
    decode: Decoder,
  ): Promise<T & { stale: boolean }> {
    const answer = await this.#transport.send<T>({
      ...route(operation, { "customer.external_id": this.id, ...variables }, asOf(options)),
      cached: true,
      revalidate: options?.revalidate,
      decode,
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  check<T extends FeatureType>(feature: Feature<T>, options?: CheckOptions): Promise<Check<T>>;
  check(feature: string, options?: CheckOptions): Promise<Check>;
  async check(feature: Feature | string, options?: CheckOptions): Promise<Check> {
    const check = await this.#cached<Check>(
      "Entitlements.CheckFeature",
      { feature_key: featureKey(feature) },
      options,
      decodeCheck,
    );
    if (typeof feature === "object" && feature.type !== check.type) {
      throw new TypeError(`${check.key} is declared ${feature.type}, but Entitler answers it as ${check.type}.`);
    }
    return check;
  }

  async isEntitled(feature: Feature | string, options: IsEntitledOptions): Promise<boolean> {
    if (typeof options?.default !== "boolean") throw new TypeError("Pass default as true or false.");
    this.#transport.checkTimeout(options);
    const key = featureKey(feature);
    asOf(options);
    try {
      return (await this.check(key, options)).entitled;
    } catch (error) {
      if ((options.signal?.aborted && error === options.signal.reason) || isClosed(error)) throw error;
      this.#transport.report(error);
      return options.default;
    }
  }

  async entitlements(options?: CheckOptions): Promise<Entitlements> {
    return new Entitlements(
      await this.#cached<EntitlementsInit>("Entitlements.ListEntitlements", {}, options, decodeEntitlements),
    );
  }
}
