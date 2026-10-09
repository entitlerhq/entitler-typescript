import { type CacheEntry, type CacheStore, MemoryCache } from "./cache.js";
import { ApiError, ConnectionError, type EntitlerError, type ErrorCode, TimeoutError } from "./errors.js";
import { instant, sha256Hex, sleep, wholeNumber } from "./util.js";
import { VERSION } from "./version.js";

/** Options both clients take. */
export interface ClientOptions {
  /** The API's base URL. Defaults to `https://api.entitler.dev`. */
  baseUrl?: string;
  /** Each attempt's deadline in milliseconds, from connecting to the last byte. Defaults to 10,000. */
  timeout?: number;
  /** How many times to retry after the first attempt. Defaults to 2. */
  maxRetries?: number;
  /** The longest `Retry-After` the SDK waits for, in milliseconds. Defaults to 10,000. */
  maxRetryDelay?: number;
  /** Where to keep answers: a {@link CacheStore}, or `false` for none. Defaults to a {@link MemoryCache} of 1,000 answers. */
  cache?: CacheStore | false;
  /** How long a kept answer may stand in while Entitler is unreachable, in milliseconds. Defaults to 24 hours. */
  staleFor?: number;
  /** Called with each error a fallback absorbed: a stale answer, an `isEntitled` default, a failed release. */
  onError?: (error: unknown) => void;
  /**
   * Reads the API at another instant. Needs the organisation's `as_of` capability
   * (`409 limit_reached` otherwise); pricing is always computed now, and writes take it only in a
   * test environment.
   */
  asOf?: Date | string;
  /** The `fetch` to send requests with, for tests, proxies and instrumentation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Options every method takes. */
export interface CallOptions {
  /** Cancels the call, including any wait between retries. */
  signal?: AbortSignal;
  /** This call's per-attempt deadline in milliseconds, in place of the client's. */
  timeout?: number;
}

/** Options every write method takes. */
export interface WriteOptions extends CallOptions {
  /**
   * The idempotency key, 1 to 200 printable ASCII characters. Derive it from your own unit of
   * work (a job id, a message id) so a retry from another process is recognised; the SDK
   * generates one when it is left out.
   */
  idempotencyKey?: string;
}

/** A credential's request headers and the principal answers are kept under. @internal */
export interface Authorised {
  readonly headers: Record<string, string>;
  readonly principal: string;
  readonly token?: string;
}

/** How a client signs its requests. @internal */
export interface Credentials {
  readonly kind: string;
  authorise(signal: AbortSignal | undefined): Promise<Authorised>;
  refresh?(used: Authorised, signal: AbortSignal | undefined): Promise<Authorised | undefined>;
}

/** One request. @internal */
export interface Call {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string | undefined>;
  readonly idempotencyKey?: string;
  readonly cached?: boolean;
  readonly customer?: string;
  readonly open?: boolean;
  readonly options?: CallOptions | undefined;
}

/** An answer, and whether it came from a kept copy. @internal */
export interface Answer<T> {
  readonly data: T;
  readonly stale: boolean;
}

interface Received {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

const DATE_KEYS = new Set([
  "addedAt",
  "asOf",
  "at",
  "cancelledAt",
  "cancelsAt",
  "createdAt",
  "endsAt",
  "expiresAt",
  "from",
  "lastAt",
  "metersStartAgainAt",
  "observedAt",
  "occurredAt",
  "openedAt",
  "paidAt",
  "readAt",
  "renewsAt",
  "resetsAt",
  "resolvedAt",
  "revokedAt",
  "seenAt",
  "since",
  "startedAt",
  "startsAt",
  "trialEndsAt",
  "until",
]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const RETRIED = new Set([408, 429, 500, 502, 503, 504]);
const PAYMENT_STATUSES = new Set(["declined", "requires_action", "processing", "pending"]);

/** Parses an answer body, turning its timestamps into `Date`s. @internal */
export function parseAnswer(text: string): unknown {
  if (text === "") return undefined;
  return JSON.parse(text, (key, value) =>
    DATE_KEYS.has(key) && typeof value === "string" && TIMESTAMP.test(value) ? new Date(value) : value,
  );
}

function runtime(): string | undefined {
  const g = globalThis as {
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { bun?: string; node?: string } };
    navigator?: { userAgent?: string };
  };
  if (g.Deno?.version?.deno) return `deno/${g.Deno.version.deno}`;
  if (g.process?.versions?.bun) return `bun/${g.process.versions.bun}`;
  if (g.process?.versions?.node) return `node/${g.process.versions.node}`;
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "workerd/unknown";
  return undefined;
}

const RUNTIME = runtime();

function retryAfterOf(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function maxAgeOf(headers: Headers): number | undefined | "no-store" {
  const control = headers.get("cache-control")?.toLowerCase() ?? "";
  if (/(^|[\s,])no-store($|[\s,])/.test(control)) return "no-store";
  const maxAge = /(?:^|[\s,])max-age=(\d+)/.exec(control)?.[1];
  if (maxAge !== undefined) return Number(maxAge);
  return /(^|[\s,])no-cache($|[\s,])/.test(control) ? 0 : undefined;
}

function apiError(received: Received, idempotencyKey: string | undefined): ApiError {
  let body: { error?: Record<string, unknown> } | undefined;
  try {
    body = JSON.parse(received.text);
  } catch {
    body = undefined;
  }
  const error = body && typeof body.error === "object" && body.error ? body.error : {};
  const payment = error.payment as { status?: unknown; url?: unknown } | undefined;
  return new ApiError({
    status: received.status,
    code: typeof error.code === "string" ? (error.code as ErrorCode) : "http_error",
    message:
      typeof error.message === "string" ? error.message : `Entitler request failed with HTTP ${received.status}.`,
    requestId: received.headers.get("x-request-id") ?? undefined,
    retryAfter: retryAfterOf(received.headers),
    idempotencyKey,
    payment:
      payment && typeof payment.status === "string" && PAYMENT_STATUSES.has(payment.status)
        ? {
            status: payment.status as "declined",
            url: typeof payment.url === "string" ? payment.url : null,
          }
        : undefined,
    listingGaps: Array.isArray(error.listingGaps) ? error.listingGaps : [],
    listingProblems: Array.isArray(error.listingProblems) ? error.listingProblems : [],
  });
}

/** True for failures that mean Entitler is unreachable, which a kept answer may stand in for. @internal */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    error instanceof TimeoutError ||
    (error instanceof ApiError && (error.status === 429 || error.status >= 500))
  );
}

/** The one transport both clients share: headers, retries, timeouts, idempotency and the cache. @internal */
export class Transport {
  readonly baseUrl: string;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly #timeout: number;
  readonly #maxRetries: number;
  readonly #maxRetryDelay: number;
  readonly #staleFor: number;
  readonly #cache: CacheStore | undefined;
  readonly #asOf: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #credentials: Credentials;
  readonly #headers: () => Record<string, string>;
  readonly #writes = new Map<string, number>();

  constructor(options: ClientOptions, credentials: Credentials, headers: () => Record<string, string> = () => ({})) {
    this.baseUrl = (options.baseUrl ?? "https://api.entitler.dev").replace(/\/+$/, "");
    this.#timeout = positive(options.timeout ?? 10_000, "timeout");
    this.#maxRetries = wholeNumber(options.maxRetries ?? 2, "maxRetries", 0);
    this.#maxRetryDelay = wholeNumber(options.maxRetryDelay ?? 10_000, "maxRetryDelay", 0);
    this.#staleFor = wholeNumber(options.staleFor ?? 86_400_000, "staleFor", 0);
    this.#cache = options.cache === false ? undefined : (options.cache ?? new MemoryCache());
    this.#asOf = instant(options.asOf, "Pass asOf as a valid date.");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.onError = options.onError;
    this.#credentials = credentials;
    this.#headers = headers;
  }

  get kind(): string {
    return this.#credentials.kind;
  }

  async send<T>(call: Call): Promise<Answer<T>> {
    const signal = call.options?.signal;
    signal?.throwIfAborted();
    let auth = call.open ? { headers: {}, principal: "" } : await this.#credentials.authorise(signal);
    const url = this.#url(call);
    const headers = this.#requestHeaders(call);
    if (!call.cached) {
      try {
        return { data: parseAnswer((await this.#exchange(call, url, headers, auth)).text) as T, stale: false };
      } finally {
        if (call.method !== "GET" && call.customer !== undefined) this.#writes.set(call.customer, Date.now());
      }
    }
    const cache = this.#cache;
    const key = cache
      ? await sha256Hex(
          JSON.stringify([
            call.method,
            url,
            headers["Entitler-As-Of"] ?? null,
            headers["Entitler-Visitor"] ?? null,
            auth.principal,
          ]),
        )
      : "";
    const kept = cache ? await cache.get(key) : undefined;
    if (kept && this.#fresh(kept, call.customer)) return { data: parseAnswer(kept.body) as T, stale: false };
    if (kept?.etag) headers["If-None-Match"] = kept.etag;
    let received: Received;
    try {
      received = await this.#exchange(call, url, headers, auth, (refreshed) => {
        auth = refreshed;
      });
    } catch (error) {
      if (kept && isUnreachable(error) && Date.now() - kept.receivedAt < this.#staleFor) {
        this.onError?.(error);
        return { data: parseAnswer(kept.body) as T, stale: true };
      }
      throw error;
    }
    if (received.status === 304) {
      if (!kept) throw apiError(received, undefined);
      const maxAge = maxAgeOf(received.headers);
      const renewed: CacheEntry = {
        body: kept.body,
        ...withEtag(received.headers.get("etag") ?? kept.etag),
        ...(typeof maxAge === "number" ? { maxAge } : {}),
        receivedAt: Date.now(),
      };
      if (maxAge !== "no-store") await cache?.set(key, renewed);
      return { data: parseAnswer(kept.body) as T, stale: false };
    }
    const maxAge = maxAgeOf(received.headers);
    const etag = received.headers.get("etag") ?? undefined;
    if (cache && maxAge !== "no-store" && (etag !== undefined || maxAge !== undefined)) {
      await cache.set(key, {
        body: received.text,
        ...withEtag(etag),
        ...(maxAge !== undefined ? { maxAge } : {}),
        receivedAt: Date.now(),
      });
    }
    return { data: parseAnswer(received.text) as T, stale: false };
  }

  #fresh(entry: CacheEntry, customer: string | undefined): boolean {
    if (entry.maxAge === undefined || Date.now() - entry.receivedAt >= entry.maxAge * 1000) return false;
    const wrote = customer === undefined ? undefined : this.#writes.get(customer);
    return wrote === undefined || wrote < entry.receivedAt;
  }

  #url(call: Call): string {
    const query = Object.entries(call.query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined);
    const search = query.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
    return `${this.baseUrl}${call.path}${search ? `?${search}` : ""}`;
  }

  #requestHeaders(call: Call): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", ...this.#headers() };
    if (RUNTIME) headers["User-Agent"] = `entitler-typescript/${VERSION} ${RUNTIME}`;
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey;
    if (this.#asOf) headers["Entitler-As-Of"] = this.#asOf;
    for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
    return headers;
  }

  async #exchange(
    call: Call,
    url: string,
    headers: Record<string, string>,
    auth: Authorised,
    onRefresh?: (auth: Authorised) => void,
  ): Promise<Received> {
    const signal = call.options?.signal;
    const timeout = positive(call.options?.timeout ?? this.#timeout, "timeout");
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    let refreshed = false;
    for (let retry = 0; ; ) {
      let failure: EntitlerError;
      try {
        const received = await this.#attempt(
          url,
          call.method,
          { ...headers, ...auth.headers },
          body,
          signal,
          timeout,
          call,
        );
        if (received.status < 300 || received.status === 304) return received;
        failure = apiError(received, call.idempotencyKey);
        if (received.status === 401 && !refreshed && this.#credentials.refresh) {
          refreshed = true;
          const next = await this.#credentials.refresh(auth, signal);
          if (next) {
            auth = next;
            onRefresh?.(next);
            continue;
          }
        }
        if (!RETRIED.has(received.status)) throw failure;
      } catch (error) {
        if (!(error instanceof ConnectionError || error instanceof TimeoutError)) throw error;
        failure = error;
      }
      const retryAfter = failure instanceof ApiError ? failure.retryAfter : undefined;
      if (retryAfter !== undefined && retryAfter > this.#maxRetryDelay) throw failure;
      if (retry >= this.#maxRetries) throw failure;
      await sleep(retryAfter ?? Math.random() * Math.min(8000, 500 * 2 ** retry), signal);
      retry += 1;
    }
  }

  async #attempt(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
    timeout: number,
    call: Call,
  ): Promise<Received> {
    const deadline = AbortSignal.timeout(timeout);
    const send = this.#fetch;
    try {
      const response = await send(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) {
        throw new TimeoutError(`Entitler did not answer within ${timeout} ms.`, {
          cause,
          idempotencyKey: call.idempotencyKey,
        });
      }
      throw new ConnectionError("Entitler could not be reached.", { cause, idempotencyKey: call.idempotencyKey });
    }
  }
}

function withEtag(etag: string | undefined): { etag?: string } {
  return etag === undefined ? {} : { etag };
}

function positive(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Pass ${name} as a number of milliseconds above 0.`);
  }
  return value;
}
