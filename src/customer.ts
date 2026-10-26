import { Entitlements, type EntitlementsInit } from "./entitlements.js";
import { ApiError, UsageRefusedError, UsageReplayedError, UsageSettlementError } from "./errors.js";
import { type Operation, route } from "./routes.js";
import { type Decoder, decodeCheck, decodeEntitlements, decodeUsage } from "./shapes.js";
import { type CallOptions, isClosed, type ReadOptions, type Transport } from "./transport.js";
import type { Check, Feature, FeatureType, UsageMode, UsageResult } from "./types.js";
import { deadlineAfter, featureKey, requiredKey, requireId, wholeNumber } from "./util.js";

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

/** Options every usage report and hold takes: the idempotency key is required. */
export interface UsageWriteOptions extends CallOptions {
  /**
   * A key naming the event in your own system (this message, this export request, this webhook
   * delivery), 1 to 200 printable ASCII characters. Required: the API keeps it, so a retry from
   * another process or after a restart never charges twice.
   */
  idempotencyKey: string;
}

/** Options for {@link Customer.recordUsage}. */
export interface RecordUsageOptions extends UsageWriteOptions {
  /**
   * `gate` (the default) records only when the amount fits the allowance, else answers
   * `refused`; `observe` always records what happened, and `overBy` says how far past it is.
   */
  mode?: UsageMode;
  /** When the usage happened, so it counts in that period. */
  occurredAt?: Date;
  /** Registers a customer not registered yet, if the credential may register customers. */
  register?: boolean;
}

/** Options for {@link Customer.holdUsage}, {@link Customer.startHold} and {@link Customer.withHold}. */
export interface HoldOptions extends UsageWriteOptions {
  /** How long the hold lasts, 1 to 3,600 seconds. Defaults to 300. */
  ttlSeconds?: number;
}

/**
 * An open hold, from {@link Customer.startHold}. Report the amount used with `use(n)`, then call
 * `finish()` however the work ended, or `release()` for work that never ran. Only the first of
 * `finish`, `release` and disposal acts; a later call answers the first one's result.
 *
 * @example
 * ```ts
 * await using hold = await customer.startHold(aiCredits, 2_000, { idempotencyKey: messageId });
 * hold.use(0);
 * for await (const chunk of stream) hold.use(chunk.totalTokens);
 * await hold.finish();
 * ```
 */
export interface Hold {
  /** The hold's id. */
  readonly id: string;
  /** The amount held. */
  readonly amount: number;
  /** When the hold expires unless settled or released. */
  readonly expiresAt: Date;
  /** The hold's answer, with the meter. */
  readonly result: UsageResult;
  /** True when another caller holds the same key and may be doing the same work. */
  readonly duplicate: boolean;
  /**
   * Reports the total the work really used so far, a whole number of 0 or more, with no
   * request; a later call replaces an earlier one. Work that reports as it goes calls `use(0)`
   * before it starts, so finishing after a failure that used nothing frees the whole hold.
   */
  use(amount: number): void;
  /**
   * Ends the work, whether it succeeded, failed or was cut off: settles the amount reported (the
   * held amount when none was), records any excess in `observe` mode under the hold's key plus
   * `:excess`, and records the whole amount there when the hold expired first. Runs with its own
   * timeout, never the caller's signal. Throws {@link UsageSettlementError} when that fails.
   */
  finish(): Promise<UsageResult>;
  /** Frees the hold, recording nothing, for work that never ran. */
  release(): Promise<UsageResult>;
  /**
   * The disposal `await using` runs: when neither `finish()` nor `release()` ran, settles the amount
   * reported, else releases. A failure goes to `onError`; it never throws. Defined where the
   * runtime has `Symbol.asyncDispose`.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/** What `withHold`'s work receives. */
export interface HoldContext {
  /** The open hold, to report the amount used with `hold.use(n)` and to read `hold.duplicate`. */
  readonly hold: Hold;
  /** The call's signal, to pass on to the work. */
  readonly signal: AbortSignal;
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
  /**
   * Records usage of a metered feature. A refusal in `gate` mode is an answer (`outcome:
   * "refused"`), not an error.
   *
   * @example
   * ```ts
   * const result = await customer.recordUsage(exports, 1, { idempotencyKey: job.id });
   * if (result.outcome === "refused") showUpgrade(result.upgrades);
   * ```
   */
  recordUsage(feature: Feature<"metered">, amount: number, options: RecordUsageOptions): Promise<UsageResult>;
  /**
   * Holds an amount while work runs, opens a {@link Hold} for it, and throws
   * {@link UsageRefusedError} when the customer has too little left.
   */
  startHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Hold>;
  /**
   * Holds an amount, runs `work`, then settles what `work` reported with `hold.use(n)`, or the whole
   * hold when it reported nothing. When `work` throws, settles what it reported or frees the hold.
   * Throws {@link UsageRefusedError} before `work` runs when the customer has too little left, and
   * {@link UsageSettlementError} holding `work`'s result when settling fails.
   *
   * @example
   * ```ts
   * const reply = await customer.withHold(
   *   aiCredits,
   *   2_000,
   *   async ({ hold, signal }) => {
   *     const answer = await model.generate(prompt, { signal });
   *     hold.use(answer.usage.totalTokens);
   *     return answer.text;
   *   },
   *   { idempotencyKey: messageId },
   * );
   * ```
   */
  withHold<R>(
    feature: Feature<"metered">,
    amount: number,
    work: (context: HoldContext) => R | Promise<R>,
    options: HoldOptions,
  ): Promise<R>;
  /** Holds an amount, answering the refusal instead of throwing; the building block of `startHold`. */
  holdUsage(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<UsageResult>;
  /** Settles a hold with the amount really used, from 0 to the held amount. */
  settleUsage(holdId: string, amount: number, options?: CallOptions): Promise<UsageResult>;
  /** Frees a hold, recording nothing. */
  releaseUsage(holdId: string, options?: CallOptions): Promise<UsageResult>;
}

const USAGE_AMOUNT = `Pass amount as a whole number from 1 to ${Number.MAX_SAFE_INTEGER}.`;
const SETTLED_AMOUNT = "Pass amount as a whole number from 0 to the held amount.";
const AMOUNT_USED = "Pass the amount used as a whole number of 0 or more.";
const EXCESS = ":excess";
const DISPOSE = Symbol("dispose");

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
      customer: this.id,
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

  async #usage(
    operation: Operation,
    variables: Record<string, string>,
    body: Record<string, unknown> | undefined,
    options: CallOptions | undefined,
    idempotencyKey?: string,
  ): Promise<UsageResult> {
    const answer = await this.#transport.send<UsageResult>({
      ...route(operation, { "customer.external_id": this.id, ...variables }),
      body,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      retryable: true,
      changes: [this.id],
      decode: decodeUsage,
      options,
    });
    return answer.data;
  }

  async recordUsage(feature: Feature<"metered">, amount: number, options: RecordUsageOptions): Promise<UsageResult> {
    const idempotencyKey = requiredKey(options?.idempotencyKey);
    const occurredAt = options.occurredAt;
    if (occurredAt !== undefined && (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime()))) {
      throw new TypeError("Pass occurredAt as a valid date.");
    }
    return this.#usage(
      "Usage.ReportUsage",
      {},
      {
        featureKey: featureKey(feature),
        amount: wholeNumber(amount, "amount", 1, Number.MAX_SAFE_INTEGER, USAGE_AMOUNT),
        idempotencyKey,
        ...(options.mode === undefined ? {} : { mode: `USAGE_MODE_${options.mode.toUpperCase()}` }),
        ...(occurredAt === undefined ? {} : { occurredAtMs: occurredAt.getTime() }),
        ...(options.register === undefined ? {} : { register: options.register }),
      },
      options,
      idempotencyKey,
    );
  }

  async holdUsage(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<UsageResult> {
    const idempotencyKey = requiredKey(options?.idempotencyKey);
    return this.#usage(
      "Usage.CreateHold",
      {},
      {
        featureKey: featureKey(feature),
        amount: wholeNumber(amount, "amount", 1, Number.MAX_SAFE_INTEGER, USAGE_AMOUNT),
        idempotencyKey,
        ...(options.ttlSeconds === undefined
          ? {}
          : { ttlSeconds: wholeNumber(options.ttlSeconds, "ttlSeconds", 1, 3600) }),
      },
      options,
      idempotencyKey,
    );
  }

  async settleUsage(holdId: string, amount: number, options?: CallOptions): Promise<UsageResult> {
    return this.#usage(
      "Usage.SettleHold",
      { hold_id: requireId(holdId, "Provide the id of the hold.") },
      { amount: wholeNumber(amount, "amount", 0, Number.MAX_SAFE_INTEGER, SETTLED_AMOUNT) },
      options,
    );
  }

  async releaseUsage(holdId: string, options?: CallOptions): Promise<UsageResult> {
    return this.#usage(
      "Usage.ReleaseHold",
      { hold_id: requireId(holdId, "Provide the id of the hold.") },
      undefined,
      options,
    );
  }

  async startHold(feature: Feature<"metered">, amount: number, options: HoldOptions): Promise<Hold> {
    const key = requiredKey(options?.idempotencyKey, 200 - EXCESS.length);
    const answer = await this.holdUsage(feature, amount, options);
    if (answer.outcome === "refused") throw new UsageRefusedError(answer);
    const open =
      answer.holdId !== null &&
      answer.expiresAt !== null &&
      (answer.outcome === "held" ||
        (answer.outcome === "duplicate" && answer.expiresAt.getTime() > answer.asOf.getTime()));
    if (!open) throw new UsageReplayedError(answer);
    return this.#hold(feature, key, answer, options.timeout);
  }

  #hold(feature: Feature<"metered">, key: string, answer: UsageResult, timeout: number | undefined): Hold {
    const holdId = answer.holdId as string;
    let used: number | undefined;
    let first: Promise<UsageResult> | undefined;
    const call = (): CallOptions => ({
      signal: deadlineAfter(timeout ?? this.#transport.timeout),
      ...(timeout === undefined ? {} : { timeout }),
    });
    const settle = async (): Promise<UsageResult> => {
      const total = used ?? answer.amount;
      const settled = Math.min(total, answer.amount);
      const excess = total > answer.amount ? total - answer.amount : undefined;
      const observe = (amount: number) =>
        this.recordUsage(feature, amount, { ...call(), mode: "observe", idempotencyKey: key + EXCESS });
      let unrecorded = excess;
      try {
        let result: UsageResult;
        try {
          result = await this.settleUsage(holdId, settled, call());
        } catch (error) {
          if (!(error instanceof ApiError && error.reason === "HOLD_EXPIRED") || total === 0) throw error;
          unrecorded = total;
          return await observe(total);
        }
        if (excess !== undefined) await observe(excess);
        return result;
      } catch (cause) {
        throw new UsageSettlementError({ holdId, amount: settled, excess: unrecorded, result: undefined, cause });
      }
    };
    const release = () => this.releaseUsage(holdId, call());
    const act = (action: () => Promise<UsageResult>) => {
      first ??= action();
      return first;
    };
    const dispose = async (): Promise<void> => {
      if (first) return;
      try {
        await act(used === undefined ? release : settle);
      } catch (error) {
        this.#transport.report(error);
      }
    };
    return {
      id: holdId,
      amount: answer.amount,
      expiresAt: answer.expiresAt as Date,
      result: answer,
      duplicate: answer.outcome === "duplicate",
      use(value: number) {
        used = wholeNumber(value, "the amount used", 0, Number.MAX_SAFE_INTEGER, AMOUNT_USED);
      },
      finish: () => act(settle),
      release: () => act(release),
      ...(typeof Symbol.asyncDispose === "symbol" ? { [Symbol.asyncDispose]: dispose } : {}),
      [DISPOSE]: dispose,
    } as Hold;
  }

  async withHold<R>(
    feature: Feature<"metered">,
    amount: number,
    work: (context: HoldContext) => R | Promise<R>,
    options: HoldOptions,
  ): Promise<R> {
    if (typeof work !== "function") throw new TypeError("Pass work as a function.");
    const hold = await this.startHold(feature, amount, options);
    const signal = options.signal;
    let result: R;
    try {
      result = await untilAborted(
        Promise.resolve(work({ hold, signal: signal ?? new AbortController().signal })),
        signal,
      );
    } catch (error) {
      await (hold as Hold & { [DISPOSE]: () => Promise<void> })[DISPOSE]();
      throw error;
    }
    try {
      await hold.finish();
    } catch (error) {
      if (!(error instanceof UsageSettlementError)) throw error;
      throw new UsageSettlementError({
        holdId: error.holdId,
        amount: error.amount,
        excess: error.excess,
        result,
        cause: error.cause,
      });
    }
    return result;
  }
}
