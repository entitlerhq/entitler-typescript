import type { AnswerContext, Entitlement, Feature, Served } from "./types.js";
import { featureKey } from "./util.js";

/** The fields an {@link Entitlements} value is built from. */
export interface EntitlementsInit extends AnswerContext {
  /** Every entitlement, groups included. */
  readonly entitlements: readonly Entitlement[];
  /** True only when answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;
}

/**
 * A customer's entitlement list, groups included, each item with Entitler's decision.
 *
 * @example
 * ```ts
 * const entitlements = await customer.entitlements();
 * if (entitlements.has("collaboration")) showSharing();
 * ```
 */
export class Entitlements implements Iterable<Entitlement>, AnswerContext {
  /** The customer's external id. */
  readonly customer: string;
  /** Entitler's id for the customer. */
  readonly customerId: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** When the answer next changes on its own, or `null`. */
  readonly nextChangeAt: Date | null;
  /** The catalogue the answer comes from. */
  readonly served: Served;
  /** Every entitlement, groups included. */
  readonly entitlements: readonly Entitlement[];
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;

  /** Creates an entitlement list. The SDK builds these; apps rarely need to. */
  constructor(init: EntitlementsInit) {
    this.customer = init.customer;
    this.customerId = init.customerId;
    this.asOf = init.asOf;
    this.nextChangeAt = init.nextChangeAt;
    this.served = init.served;
    this.entitlements = init.entitlements;
    this.stale = init.stale;
  }

  /** Answers the feature's entitlement, or `undefined` when the list does not hold it. */
  get(feature: Feature | string): Entitlement | undefined {
    const key = featureKey(feature);
    return this.entitlements.find((entitlement) => entitlement.key === key);
  }

  /** Answers Entitler's decision for the feature, and `false` when the list does not hold it. */
  has(feature: Feature | string): boolean {
    return this.get(feature)?.entitled ?? false;
  }

  /** Iterates the entitlements. */
  [Symbol.iterator](): Iterator<Entitlement> {
    return this.entitlements[Symbol.iterator]();
  }
}
