import type {
  AnswerContext,
  Entitlement,
  Environment,
  EnvironmentRef,
  Experiment,
  Feature,
  TrackRef,
} from "./types.js";
import { featureKey } from "./util.js";

/** The fields an {@link Entitlements} value is built from. */
export interface EntitlementsInit<E extends EnvironmentRef = Environment> extends Omit<AnswerContext, "environment"> {
  /** The environment the answer comes from. */
  readonly environment: E;
  /** The customer's external id. */
  readonly customer: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
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
 * if (entitlements.has(features.collaboration)) showSharing();
 * ```
 */
export class Entitlements<E extends EnvironmentRef = Environment> implements Iterable<Entitlement> {
  /** The customer's external id. */
  readonly customer: string;
  /** The instant the answer was computed for. */
  readonly asOf: Date;
  /** The environment the answer comes from; a snapshot names it by `id` alone. */
  readonly environment: E;
  /** The track the customer resolved to. */
  readonly track: TrackRef;
  /** The release the answer comes from, or `null`. */
  readonly release: number | null;
  /** The change the answer comes from, or `null`. */
  readonly change: string | null;
  /** True on a track for testers and in a test environment. */
  readonly testers: boolean;
  /** The experiment and arm the customer is in, or `null`. */
  readonly experiment: Experiment | null;
  /** Every entitlement, groups included. */
  readonly entitlements: readonly Entitlement[];
  /** True only when the SDK answered from a kept copy because Entitler was unreachable. */
  readonly stale: boolean;

  /** Creates an entitlement list. The SDK builds these; apps rarely need to. */
  constructor(init: EntitlementsInit<E>) {
    this.customer = init.customer;
    this.asOf = init.asOf;
    this.environment = init.environment;
    this.track = init.track;
    this.release = init.release;
    this.change = init.change;
    this.testers = init.testers;
    this.experiment = init.experiment;
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
