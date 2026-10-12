import type { Transport } from "./transport.js";
import type { Scope } from "./types.js";

/** A client's JSON form: its base URL and kind, never its credential. */
export interface ClientDescription<K extends string = string> {
  /** The API's base URL. */
  readonly baseUrl: string;
  /** The client's kind: `server`, `token`, `identity` or `publishable`. */
  readonly kind: K;
}

const SCOPES: readonly Scope[] = [
  "plans:read",
  "entitlements:read",
  "usage:read",
  "usage:write",
  "billing:self",
  "customers:register",
  "customers:read",
  "customers:write",
  "customers:profile",
  "customers:sample",
  "tokens:mint",
  "plans:write",
  "plans:release",
  "tracks:manage",
  "tracks:promote",
  "tracks:assign",
  "keys:manage",
  "members:manage",
  "projects:manage",
  "org:manage",
];

/** Keeps the scopes the SDK knows, in its fixed order. @internal */
export function knownScopes(scopes: unknown): Scope[] {
  const held = new Set(Array.isArray(scopes) ? scopes : []);
  return SCOPES.filter((scope) => held.has(scope));
}

/** A client's string form: its base URL and kind, never its credential. @internal */
export function describe(name: string, transport: Transport): string {
  return `${name} { baseUrl: ${transport.baseUrl}, kind: ${transport.kind} }`;
}
