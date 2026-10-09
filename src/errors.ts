import type { ListingGap, ListingProblem, Open, UsageResult } from "./types.js";

/**
 * Every error code the Entitler API documents, plus the SDK's own `http_error` for an answer
 * without a readable error body. Unknown codes from newer API releases still type-check.
 */
export type ErrorCode = Open<
  | "allowance_reached"
  | "already_connected"
  | "as_of_not_allowed"
  | "body_too_large"
  | "browser_not_allowed"
  | "cap_reached"
  | "carry_forward_conflict"
  | "catalogue_not_empty"
  | "change_locked"
  | "change_required"
  | "connection_in_use"
  | "connection_mode"
  | "connection_required"
  | "connection_unreadable"
  | "credential_not_allowed"
  | "customer_not_found"
  | "email_taken"
  | "email_unconfirmed"
  | "experiment_running"
  | "feature_not_found"
  | "hold_expired"
  | "hold_released"
  | "hold_settled"
  | "http_error"
  | "idempotency_key_required"
  | "idempotency_mismatch"
  | "internal"
  | "invalid_amount"
  | "invalid_body"
  | "invalid_idempotency_key"
  | "invalid_occurred_at"
  | "invalid_path"
  | "last_environment"
  | "limit_reached"
  | "listing_gaps"
  | "listing_invalid"
  | "method_not_allowed"
  | "not_found"
  | "not_listed"
  | "not_metered"
  | "not_self_serve"
  | "payment_required"
  | "person_required"
  | "plan_still_billed"
  | "provider_account_changed"
  | "provider_partial"
  | "publication_failed"
  | "rate_limited"
  | "review_required"
  | "scope_required"
  | "sign_ups_closed"
  | "stale"
  | "switch_in_use"
  | "switch_needed"
  | "switch_off"
  | "too_many_customers"
  | "track_closed"
  | "unauthorised"
  | "unavailable"
>;

/** A payment a plan change waits on, from a `402 payment_required` answer. */
export interface PaymentRequired {
  /** Why the payment has not succeeded yet. */
  readonly status: "declined" | "requires_action" | "processing" | "pending";
  /** The provider's page where the customer pays or confirms the payment, or `null`. */
  readonly url: string | null;
}

/** The base class of every error the SDK raises, so one `instanceof` check catches them all. */
export class EntitlerError extends Error {
  override name = "EntitlerError";
}

/** Fields an {@link ApiError} is built from. */
export interface ApiErrorInit {
  /** The HTTP status. */
  status: number;
  /** The error code from the body, else `http_error`. */
  code: ErrorCode;
  /** The error message from the body, else a message naming the status. */
  message: string;
  /** The `x-request-id` header, when present. */
  requestId?: string | undefined;
  /** The `Retry-After` header in milliseconds, when present. */
  retryAfter?: number | undefined;
  /** The idempotency key the request sent, when it sent one. */
  idempotencyKey?: string | undefined;
  /** The payment a plan change waits on, when the API named one. */
  payment?: PaymentRequired | undefined;
  /** The listing gaps from the body. */
  listingGaps?: readonly ListingGap[] | undefined;
  /** The listing problems from the body. */
  listingProblems?: readonly ListingProblem[] | undefined;
}

/**
 * The API answered with a status other than 2xx.
 *
 * @example
 * ```ts
 * try {
 *   await customer.subscribe("pro");
 * } catch (error) {
 *   if (error instanceof ApiError && error.code === "not_self_serve") showContactSales();
 *   else throw error;
 * }
 * ```
 */
export class ApiError extends EntitlerError {
  override name = "ApiError";
  /** The HTTP status. */
  readonly status: number;
  /** The API's error code, or `http_error` when the answer had no readable error body. */
  readonly code: ErrorCode;
  /** The `x-request-id` header, for Entitler support. */
  readonly requestId: string | undefined;
  /** How long the API asked to wait before trying again, in milliseconds. */
  readonly retryAfter: number | undefined;
  /** The idempotency key the request sent, so the call can be repeated later with it. */
  readonly idempotencyKey: string | undefined;
  /** The payment a plan change waits on, from `402 payment_required`. */
  readonly payment: PaymentRequired | undefined;
  /** The gaps a rollout would leave, from `409 listing_gaps`; empty otherwise. */
  readonly listingGaps: readonly ListingGap[];
  /** The listings whose provider price fails the checks, from `409 listing_invalid`; empty otherwise. */
  readonly listingProblems: readonly ListingProblem[];

  /** Creates an API error. The SDK raises these; apps rarely need to. */
  constructor(init: ApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.idempotencyKey = init.idempotencyKey;
    this.payment = init.payment;
    this.listingGaps = init.listingGaps ?? [];
    this.listingProblems = init.listingProblems ?? [];
  }
}

/** No answer arrived: DNS, TLS, or a connection refused or reset. The cause is in `cause`. */
export class ConnectionError extends EntitlerError {
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
  override name = "TimeoutError";
  /** The idempotency key the request sent, when it sent one. */
  readonly idempotencyKey: string | undefined;

  /** Creates a timeout error. The SDK raises these; apps rarely need to. */
  constructor(message: string, options: { cause?: unknown; idempotencyKey?: string | undefined } = {}) {
    super(message, { cause: options.cause });
    this.idempotencyKey = options.idempotencyKey;
  }
}

/** A token provider failed, or answered a blank or unreadable token. The cause is in `cause`. */
export class TokenError extends EntitlerError {
  override name = "TokenError";
}

/** Why a snapshot failed verification. */
export type SnapshotErrorCode = "snapshot_invalid" | "snapshot_expired";

/** A snapshot failed verification. No request was made, so there is no HTTP status. */
export class SnapshotError extends EntitlerError {
  override name = "SnapshotError";
  /** `snapshot_expired` once the snapshot's `exp` has passed, else `snapshot_invalid`. */
  readonly code: SnapshotErrorCode;

  /** Creates a snapshot error. The SDK raises these; apps rarely need to. */
  constructor(code: SnapshotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Raised only by `withHold` when Entitler refuses the hold, before the work runs. Everywhere
 * else a refusal is an answer, not an error.
 */
export class UsageRefusedError extends EntitlerError {
  override name = "UsageRefusedError";
  /** The refused answer, with its `refusal` and the meter. */
  readonly result: UsageResult;

  /** Creates a refusal error from the refused hold's answer. */
  constructor(result: UsageResult) {
    super(
      result.refusal === "not_entitled"
        ? `The customer is not entitled to ${result.feature}.`
        : `The customer has too little ${result.feature} left for ${result.amount}.`,
    );
    this.result = result;
  }
}

/** A settlement failed after the work succeeded. Settle again with `holdId`; the cause is in `cause`. */
export class SettleError extends EntitlerError {
  override name = "SettleError";
  /** The hold that is still open. */
  readonly holdId: string;
  /** The amount the work used, to settle with. */
  readonly amount: number;

  /** Creates a settlement error. The SDK raises these; apps rarely need to. */
  constructor(holdId: string, amount: number, cause: unknown) {
    super(`Entitler could not settle hold ${holdId}. Settle it again with settleUsage().`, { cause });
    this.holdId = holdId;
    this.amount = amount;
  }
}
