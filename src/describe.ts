import type { Transport } from "./transport.js";

/** A client's JSON form: its base URL and kind, never its credential. */
export interface ClientDescription<K extends string = string> {
  /** The API's base URL. */
  readonly baseUrl: string;
  /** The client's kind, such as `server`. */
  readonly kind: K;
}

/** A client's string form: its base URL and kind, never its credential. @internal */
export function describe(name: string, transport: Transport): string {
  return `${name} { baseUrl: ${transport.baseUrl}, kind: ${transport.kind} }`;
}
