import { Entitlements } from "./entitlements.js";
import { SnapshotError } from "./errors.js";
import { parseAnswer } from "./transport.js";
import type { Entitlement, EnvironmentRef, SnapshotKey, SnapshotKeys, TrackRef } from "./types.js";
import { base64UrlDecode, decodeJson, requireText } from "./util.js";

/** What a snapshot must match to verify. */
export interface ExpectedSnapshot {
  /** The keys that may have signed it: the key set from `snapshotKeys()`, or its `keys`. Ship them with the app. */
  keys: SnapshotKeys | readonly SnapshotKey[];
  /** The signed-in customer's external id. */
  customer: string;
  /** The app's environment id. */
  environment: string;
  /** The expected issuer. Defaults to `https://api.entitler.dev/customers`. */
  issuer?: string;
  /** The time to verify at. Defaults to the system clock. */
  now?: Date;
  /** How far ahead a snapshot's `iat` may be, a whole number of seconds from 0 to 300. Defaults to 60. */
  clockSkewSeconds?: number;
}

/** A verified snapshot: whose it is, where it is from, and the entitlements it signs. */
export interface VerifiedSnapshot {
  /** The customer's external id. */
  readonly customer: string;
  /** The environment. */
  readonly environment: EnvironmentRef;
  /** The customer's track. */
  readonly track: TrackRef;
  /** The release signed, or `null`. */
  readonly release: number | null;
  /** The change signed, or `null`. */
  readonly change: string | null;
  /** True on a track for testers and in a test environment. */
  readonly testers: boolean;
  /** When it stops verifying. */
  readonly expiresAt: Date;
  /** The entitlements, frozen when it was signed (meters included), with `asOf` the signing time. */
  readonly entitlements: Entitlements<EnvironmentRef>;
}

const MAX_INSTANT_SECONDS = 8_640_000_000_000;
const NOT_A_SNAPSHOT = "That is not an entitlements snapshot. Pass the token snapshot() returned.";

function invalid(message: string, cause?: unknown): SnapshotError {
  return new SnapshotError("snapshot_invalid", message, cause === undefined ? undefined : { cause });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

interface Claims {
  iss: string;
  sub: string;
  environment: { id: string };
  track: TrackRef;
  release: number | null;
  change: string | null;
  testers: boolean;
  entitlements: Entitlement[];
  iat: number;
  exp: number;
}

function claimsOf(value: unknown): Claims | undefined {
  if (!isObject(value)) return undefined;
  const { iss, sub, environment, track, release, change, testers, entitlements, iat, exp } = value;
  const shaped =
    typeof iss === "string" &&
    typeof sub === "string" &&
    isObject(environment) &&
    typeof environment.id === "string" &&
    isObject(track) &&
    typeof track.id === "string" &&
    typeof track.name === "string" &&
    (release === null || Number.isInteger(release)) &&
    stringOrNull(change) &&
    typeof testers === "boolean" &&
    Array.isArray(entitlements) &&
    entitlements.every((item) => isObject(item) && typeof item.key === "string") &&
    instantSeconds(iat) &&
    instantSeconds(exp);
  return shaped ? (value as unknown as Claims) : undefined;
}

function instantSeconds(value: unknown): boolean {
  return Number.isInteger(value) && Math.abs(value as number) <= MAX_INSTANT_SECONDS;
}

function rfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Verifies an entitlements snapshot offline, with no request: its ES256 signature against the
 * keys you pass, its issuer, its lifetime, and that it is for the expected customer and
 * environment. Throws {@link SnapshotError} when any check fails.
 *
 * The keys decide which snapshots the app trusts: ship them with the app (from `snapshotKeys()`
 * at build time) and replace them only with keys fetched from Entitler over HTTPS. Never store
 * them beside the token or load them from the same record, since anyone who can edit that record
 * could replace both. Entitler publishes a new signing key before signing with it and keeps retired
 * keys published for 30 days after their last use, so refresh the keys from `snapshotKeys()`
 * whenever the app is online and persist them in the app's own trusted storage. An emergency
 * replacement withdraws old keys at once.
 *
 * @example
 * ```ts
 * const snapshot = await verifySnapshot(token, { keys: shippedKeys, customer: "user_123", environment: envId });
 * if (snapshot.entitlements.has(features.exportPdf)) showExport();
 * ```
 */
export async function verifySnapshot(token: string, expected: ExpectedSnapshot): Promise<VerifiedSnapshot> {
  const customer = requireText(expected?.customer, "Provide the id your app uses for the customer.");
  const environment = requireText(expected?.environment, "Provide the id of your app's environment.");
  const issuer = expected.issuer ?? "https://api.entitler.dev/customers";
  const skew = expected.clockSkewSeconds ?? 60;
  if (!Number.isInteger(skew) || skew < 0 || skew > 300) {
    throw new RangeError("Pass clockSkewSeconds as a whole number from 0 to 300.");
  }
  const keyList = Array.isArray(expected.keys) ? expected.keys : (expected.keys as SnapshotKeys | undefined)?.keys;
  if (!Array.isArray(keyList)) throw new TypeError("Pass keys as the key set snapshotKeys() answers, or its keys.");
  const now = (expected.now ?? new Date()).getTime() / 1000;

  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw invalid(NOT_A_SNAPSHOT);
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: unknown;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = decodeJson(base64UrlDecode(headerPart));
    signature = base64UrlDecode(signaturePart);
  } catch (cause) {
    throw invalid(NOT_A_SNAPSHOT, cause);
  }
  if (!isObject(header) || header.typ !== "entitlements+jwt" || header.alg !== "ES256" || "crit" in header) {
    throw invalid(NOT_A_SNAPSHOT);
  }

  const jwk = keyList.find((key) => key?.kid === header.kid);
  if (!jwk) throw invalid("None of the keys passed signed this snapshot. Fetch them again with snapshotKeys().");

  const changed = "This snapshot was changed after Entitler signed it.";
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    valid =
      signature.length === 64 &&
      (await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      ));
  } catch (cause) {
    throw invalid(changed, cause);
  }
  if (!valid) throw invalid(changed);

  let claims: Claims | undefined;
  try {
    claims = claimsOf(parseAnswer(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(payloadPart))));
  } catch (cause) {
    throw invalid(NOT_A_SNAPSHOT, cause);
  }
  if (!claims) throw invalid(NOT_A_SNAPSHOT);
  if (claims.iss !== issuer) throw invalid(`This snapshot was not issued by ${issuer}.`);
  if (claims.iat > now + skew) {
    throw invalid(
      `This snapshot was signed for ${rfc3339(claims.iat)}, which is still to come. Fetch a new one while online.`,
    );
  }
  if (now >= claims.exp) {
    throw new SnapshotError(
      "snapshot_expired",
      `This snapshot expired at ${rfc3339(claims.exp)}. Fetch a new one while online.`,
    );
  }
  if (claims.sub !== customer) {
    throw invalid(
      `This snapshot is for another customer, not ${customer}. Fetch one for the signed-in customer while online.`,
    );
  }
  if (claims.environment.id !== environment) {
    throw invalid(
      `This snapshot is from another environment, not ${environment}. Fetch one from your app's environment while online.`,
    );
  }
  return {
    customer: claims.sub,
    environment: { id: claims.environment.id },
    track: { id: claims.track.id, name: claims.track.name },
    release: claims.release,
    change: claims.change,
    testers: claims.testers,
    expiresAt: new Date(claims.exp * 1000),
    entitlements: new Entitlements({
      customer: claims.sub,
      asOf: new Date(claims.iat * 1000),
      environment: { id: claims.environment.id },
      track: { id: claims.track.id, name: claims.track.name },
      release: claims.release,
      change: claims.change,
      testers: claims.testers,
      experiment: null,
      entitlements: claims.entitlements,
      stale: false,
    }),
  };
}
