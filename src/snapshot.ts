import { Entitlements } from "./entitlements.js";
import { SnapshotError, type SnapshotFailure } from "./errors.js";
import { route } from "./routes.js";
import { decodeClaims, decodeSnapshotKeys, type SnapshotClaims } from "./shapes.js";
import type { CallOptions, Transport } from "./transport.js";
import type { SnapshotKey, SnapshotKeySet } from "./types.js";
import { requireId, wholeNumber } from "./util.js";

const ISSUER = "entitler";
const TYPE = "entitlements+jwt";

/** What a snapshot must match to verify. */
export interface SnapshotExpectation {
  /** The keys that may have signed it: a set from `snapshotKeys()`, or its `keys`. Ship them with the app. */
  keys: SnapshotKeySet | readonly SnapshotKey[];
  /** The signed-in customer's external id, from the app's own session, never from the stored snapshot. */
  customer: string;
  /** The id of the environment the app is built for. */
  environment: string;
  /** The time to verify at. Defaults to the system clock. */
  now?: Date;
  /** How far ahead of `now` a snapshot's signing time may be, a whole number of seconds from 0 to 300. Defaults to 60. */
  clockSkewSeconds?: number;
}

/** A verified snapshot: whose it is, when it was signed, and the entitlements it signs. */
export interface VerifiedSnapshot {
  /** The customer's external id. */
  readonly customer: string;
  /** The environment's id. */
  readonly environment: string;
  /** When Entitler signed it. */
  readonly issuedAt: Date;
  /** When it stops verifying. */
  readonly expiresAt: Date;
  /**
   * The entitlements as they were when it was signed, meters frozen, with `asOf` the signing time.
   * Snapshots carry no upgrades and no customer id.
   */
  readonly entitlements: Entitlements;
}

function refuse(message: string, reason: SnapshotFailure = "SNAPSHOT_INVALID", cause?: unknown): never {
  throw new SnapshotError(reason, message, cause === undefined ? undefined : { cause });
}

function base64url(part: string): Uint8Array<ArrayBuffer> {
  if (part.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(part)) refuse("The snapshot is not a compact JWS.");
  const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (part.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function json(part: string, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64url(part)));
  } catch (cause) {
    if (cause instanceof SnapshotError) throw cause;
    return refuse(`The snapshot's ${what} is not JSON.`, "SNAPSHOT_INVALID", cause);
  }
}

async function signedBy(key: SnapshotKey, signed: string, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    const verifier = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      signature,
      new TextEncoder().encode(signed),
    );
  } catch (cause) {
    return refuse(`The key ${key.kid} can't verify snapshots.`, "SNAPSHOT_INVALID", cause);
  }
}

/**
 * Verifies a snapshot offline, making no request, and answers the entitlements it signs. Checks, in
 * order: its form and header, that one of `keys` signed it, its claims, its issuer, that it was not
 * signed in the future (beyond `clockSkewSeconds`), that it has not expired, and that it is for
 * `customer` and `environment`. Throws {@link SnapshotError} at the first check that fails.
 *
 * @example
 * ```ts
 * const snapshot = await verifySnapshot(saved, { keys, customer: session.userId, environment: ENVIRONMENT_ID });
 * if (snapshot.entitlements.has("export_pdf")) showExport();
 * ```
 */
export async function verifySnapshot(token: string, expected: SnapshotExpectation): Promise<VerifiedSnapshot> {
  const skew = wholeNumber(expected?.clockSkewSeconds ?? 60, "clockSkewSeconds", 0, 300);
  const now = expected.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Pass now as a valid date.");
  const keys = Array.isArray(expected.keys) ? expected.keys : (expected.keys as SnapshotKeySet | undefined)?.keys;
  if (!Array.isArray(keys)) throw new TypeError("Pass keys as a snapshot key set or its keys.");
  if (typeof token !== "string") throw new TypeError("Pass the snapshot's token.");
  const customer = requireId(expected.customer, "Pass customer as the signed-in customer's external id.");
  const environment = requireId(expected.environment, "Pass environment as the app's environment id.");

  const parts = token.split(".");
  if (parts.length !== 3) refuse("The snapshot is not a compact JWS.");
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  const header = json(headerPart, "header") as Record<string, unknown> | null;
  if (
    typeof header !== "object" ||
    header === null ||
    header.alg !== "ES256" ||
    header.typ !== TYPE ||
    typeof header.kid !== "string" ||
    "crit" in header
  ) {
    refuse("The snapshot's header is not an Entitler snapshot's.");
  }
  const key = keys.find((candidate) => candidate.kid === header.kid && candidate.alg === "ES256");
  if (!key) refuse("None of the keys passed signed this snapshot.");
  if (!(await signedBy(key, `${headerPart}.${claimsPart}`, base64url(signaturePart)))) {
    refuse("The snapshot's signature doesn't verify.");
  }

  let claims: SnapshotClaims;
  try {
    claims = decodeClaims(json(claimsPart, "claims"));
  } catch (cause) {
    if (cause instanceof SnapshotError) throw cause;
    return refuse("The snapshot's claims are not an Entitler snapshot's.", "SNAPSHOT_INVALID", cause);
  }
  if (claims.issuer !== ISSUER) refuse("Entitler did not issue this snapshot.");
  if (claims.issuedAt.getTime() > now.getTime() + skew * 1000) refuse("The snapshot was signed in the future.");
  if (now.getTime() >= claims.expiresAt.getTime()) refuse("The snapshot expired.", "SNAPSHOT_EXPIRED");
  if (claims.customer !== customer) refuse("The snapshot is for another customer.");
  if (claims.environment !== environment) refuse("The snapshot is for another environment.");

  return {
    customer: claims.customer,
    environment: claims.environment,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    entitlements: new Entitlements({
      customer: claims.customer,
      customerId: null,
      asOf: claims.issuedAt,
      nextChangeAt: null,
      served: claims.served,
      entitlements: claims.entitlements,
      stale: false,
    }),
  };
}

/** Fetches the keys that verify snapshots, sending no credential. @internal */
export async function snapshotKeys(transport: Transport, options: CallOptions | undefined): Promise<SnapshotKeySet> {
  const answer = await transport.send<SnapshotKeySet>({
    ...route("SnapshotKeys", {}),
    open: true,
    cached: true,
    decode: decodeSnapshotKeys,
    options,
  });
  return answer.data;
}
