import type { UsageResult } from "./types.js";

const CODES: Record<number, string> = {
  400: "InvalidArgument",
  401: "Unauthenticated",
  403: "PermissionDenied",
  404: "NotFound",
  409: "Aborted",
  429: "ResourceExhausted",
  499: "Cancelled",
  500: "Internal",
  501: "Unimplemented",
  503: "Unavailable",
  504: "DeadlineExceeded",
};

/** The gRPC status name an HTTP status stands for, for an answer without a readable error body. @internal */
export function grpcCode(status: number): string {
  return CODES[status] ?? (status >= 500 ? "Internal" : "Unknown");
}

/** The base class of every error the SDK raises, so one `instanceof` check catches them all. */
export class EntitlerError extends Error {
  /** `EntitlerError`. */
  override name = "EntitlerError";
}

/** Fields an {@link ApiError} is built from. */
export interface ApiErrorInit {
  /** The HTTP status. */
  status: number;
  /** The gRPC status name from the body, such as `NotFound`. */
  code: string;
  /** Why the API refused, such as `CUSTOMER_NOT_FOUND`, or `null` when it gave no reason. */
  reason: string | null;
  /** The reason's parameters, such as `field` for an invalid argument. */
  parameters?: Record<string, string> | undefined;
  /** The `x-request-id` header, when present. */
  requestId?: string | undefined;
  /** The `Retry-After` header in milliseconds, when present. */
  retryAfter?: number | undefined;
  /** The idempotency key the request sent, when it sent one. */
  idempotencyKey?: string | undefined;
  /** What went wrong underneath, such as a decoding failure. */
  cause?: unknown;
}

/**
 * The API answered with a status other than 2xx.
 *
 * @example
 * ```ts
 * try {
 *   await customer.check("priority_support");
 * } catch (error) {
 *   if (error instanceof ApiError && error.reason === "CUSTOMER_NOT_FOUND") await customer.register();
 *   else throw error;
 * }
 * ```
 */
export class ApiError extends EntitlerError {
  /** `ApiError`. */
  override name = "ApiError";
  /**
   * The HTTP status; `0` for a redirect a browser hides (an opaque redirect), the only status the
   * platform gives.
   */
  readonly status: number;
  /** The gRPC status name, such as `NotFound` or `PermissionDenied`. */
  readonly code: string;
  /**
   * Why the API refused, such as `CUSTOMER_NOT_FOUND`, or `null` when the answer had no readable
   * error body. `RESPONSE_INVALID` is the SDK's own: a 2xx answer it cannot read.
   */
  readonly reason: string | null;
  /** The reason's parameters, such as `field` for an invalid argument. */
  readonly parameters: Readonly<Record<string, string>>;
  /** The `x-request-id` header, for Entitler support. */
  readonly requestId: string | undefined;
  /** How long the API asked to wait before trying again, in milliseconds. */
  readonly retryAfter: number | undefined;
  /** The idempotency key the request sent, so the call can be repeated later with it. */
  readonly idempotencyKey: string | undefined;

  /** Creates an API error. The SDK raises these; apps rarely need to. */
  constructor(init: ApiErrorInit) {
    super(
      `Entitler answered ${init.reason ?? init.code} (HTTP ${init.status}).`,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.parameters = init.parameters ?? {};
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.idempotencyKey = init.idempotencyKey;
  }
}

/** No answer arrived: DNS, TLS, or a connection refused or reset. The cause is in `cause`. */
export class ConnectionError extends EntitlerError {
  /** `ConnectionError`. */
  override name = "ConnectionError";
  /** The idempotency key the request sent, when it sent one. */
  readonly idempotencyKey: string | undefined;

  /** Creates a connection error. The SDK raises these; apps rarely need to. */
  constructor(message: string, options: { cause?: unknown; idempotencyKey?: string | undefined } = {}) {
    super(message, { cause: options.cause });
    this.idempotencyKey = options.idempotencyKey;
  }
}

/** An attempt took longer than the client's `timeout`. */
export class TimeoutError extends EntitlerError {
  /** `TimeoutError`. */
  override name = "TimeoutError";
  /** The idempotency key the request sent, when it sent one. */
  readonly idempotencyKey: string | undefined;

  /** Creates a timeout error. The SDK raises these; apps rarely need to. */
  constructor(message: string, options: { cause?: unknown; idempotencyKey?: string | undefined } = {}) {
    super(message, { cause: options.cause });
    this.idempotencyKey = options.idempotencyKey;
  }
}

/**
 * Raised only by `startHold` and `withHold` when Entitler refuses the hold, before any work runs:
 * the customer has no allowance for it. Everywhere else a refusal is an answer, not an error.
 */
export class UsageRefusedError extends EntitlerError {
  /** `UsageRefusedError`. */
  override name = "UsageRefusedError";
  /** The refused answer, with its `refusal`, the meter and `upgrades`. */
  readonly result: UsageResult;

  /** Creates a refusal error from the refused hold's answer. */
  constructor(result: UsageResult) {
    super(
      result.refusal === "not_entitled"
        ? `The customer is not entitled to ${result.key}.`
        : `The customer has too little ${result.key} left for ${result.amount}.`,
    );
    this.result = result;
  }
}

/**
 * Raised only by `startHold` and `withHold` when the idempotency key repeats a hold already
 * settled, released or expired: the work this key stands for already happened, so show that work's
 * result, never an upgrade prompt.
 */
export class UsageReplayedError extends EntitlerError {
  /** `UsageReplayedError`. */
  override name = "UsageReplayedError";
  /** The repeated hold's answer. */
  readonly result: UsageResult;

  /** Creates a replay error from the hold's answer. */
  constructor(result: UsageResult) {
    super("This idempotency key's hold was already settled, released or expired. Use a new key for new work.");
    this.result = result;
  }
}

/** Fields a {@link UsageSettlementError} is built from. */
export interface UsageSettlementErrorInit {
  /** The hold that is still open. */
  holdId: string;
  /** The amount to settle it with. */
  amount: number;
  /** The excess over the hold still to record in `observe` mode, or `undefined`. */
  excess: number | undefined;
  /** What `work` answered, or `undefined` from `finish()`. */
  result: unknown;
  /** Why settling or recording the excess failed. */
  cause: unknown;
}

/**
 * Raised only by a hold's `finish()`, and so by `withHold` after `work` succeeded, when settling the
 * hold or recording the excess fails after its retries. Keep the work's output, settle again with
 * `settleUsage(holdId, amount)` before the hold expires, and record `excess` under the hold's key
 * plus `:excess`.
 */
export class UsageSettlementError extends EntitlerError {
  /** `UsageSettlementError`. */
  override name = "UsageSettlementError";
  /** The hold that is still open. */
  readonly holdId: string;
  /** The amount to settle it with. */
  readonly amount: number;
  /** The excess over the hold still to record in `observe` mode, or `undefined`. */
  readonly excess: number | undefined;
  /** What `withHold`'s `work` answered, so its output is not lost; `undefined` from `finish()`. */
  readonly result: unknown;

  /** Creates a settlement error. The SDK raises these; apps rarely need to. */
  constructor(init: UsageSettlementErrorInit) {
    super(`Entitler could not settle hold ${init.holdId}. Settle it again with settleUsage().`, {
      cause: init.cause,
    });
    this.holdId = init.holdId;
    this.amount = init.amount;
    this.excess = init.excess;
    this.result = init.result;
  }
}

/**
 * True when `error` means Entitler could not be reached: a {@link ConnectionError}, a
 * {@link TimeoutError}, or an {@link ApiError} with status 408, 429, a 5xx status or reason
 * `RESPONSE_INVALID`.
 *
 * @example
 * ```ts
 * try {
 *   return await customer.check("export_pdf");
 * } catch (error) {
 *   if (!isUnreachable(error)) throw error;
 *   return lastKnownCheck;
 * }
 * ```
 */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    error instanceof TimeoutError ||
    (error instanceof ApiError &&
      (error.status === 408 || error.status === 429 || error.status >= 500 || error.reason === "RESPONSE_INVALID"))
  );
}
