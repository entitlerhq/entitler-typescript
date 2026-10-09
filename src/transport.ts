import { type CacheEntry, type CacheStore, MemoryCache } from "./cache.js";
import { ApiError, ConnectionError, type EntitlerError, type ErrorCode, TimeoutError, TokenError } from "./errors.js";
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
  /**
   * Called with each error a fallback absorbed: a stale answer, an `isEntitled` default, a hold
   * `withHold` could not release, and a custom cache store's own failures.
   */
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
   * The idempotency key, 1 to 200 printable ASCII characters, not starting or ending with a space. Derive it from your own unit of
   * work (a job id, a message id) so a retry from another process is recognised; the SDK
   * generates one when it is left out.
   */
  idempotencyKey?: string;
}

/** The kind of credential a principal is. @internal */
export type PrincipalKind = "key" | "customer-token" | "identity";

/** A credential's request headers, and the credential that keys its cached answers. @internal */
export interface Authorised {
  readonly headers: Record<string, string>;
  readonly kind: PrincipalKind;
  readonly credential: string;
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
  readonly changes?: readonly string[];
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
  readonly redirect?: boolean;
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
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "workerd";
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

function directive(control: string | undefined, name: string): boolean {
  return new RegExp(`(^|[\\s,])${name}($|[\\s,=])`, "i").test(control ?? "");
}

function maxAgeOf(control: string | undefined): number | undefined {
  const maxAge = /(?:^|[\s,])max-age=(\d+)/i.exec(control ?? "")?.[1];
  return maxAge === undefined ? undefined : Number(maxAge);
}

function ageOf(headers: Headers): number | undefined {
  const age = headers.get("age")?.trim();
  return age && /^\d+$/.test(age) ? Number(age) : undefined;
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
    message: typeof error.message === "string" ? error.message : `Entitler answered with HTTP ${received.status}.`,
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
    (error instanceof ApiError && (error.status === 429 || error.status >= 500 || error.code === "invalid_response"))
  );
}

let noStore: boolean | undefined;

function bypassesHttpCache(): boolean {
  if (noStore === undefined) {
    try {
      new Request("https://api.entitler.dev", { cache: "no-store" });
      noStore = true;
    } catch {
      noStore = false;
    }
  }
  return noStore;
}

function positive(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Pass ${name} as a number of milliseconds above 0.`);
  }
  return value;
}

const fingerprints = new Map<string, Promise<string>>();

function fingerprint(credential: string): Promise<string> {
  let digest = fingerprints.get(credential);
  if (!digest) {
    if (fingerprints.size >= 64) fingerprints.clear();
    digest = sha256Hex(credential);
    fingerprints.set(credential, digest);
  }
  return digest;
}

/** The one transport both clients share: headers, retries, timeouts, idempotency and the cache. @internal */
export class Transport {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #maxRetries: number;
  readonly #maxRetryDelay: number;
  readonly #staleFor: number;
  readonly #cache: CacheStore | undefined;
  readonly #asOf: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #credentials: Credentials;
  readonly #headers: () => Record<string, string>;
  readonly #generations = new Map<string, { generation: number; at: number }>();
  #lastAuth: Authorised | undefined;
  #downUntil = 0;
  #probing = false;

  constructor(options: ClientOptions, credentials: Credentials, headers: () => Record<string, string> = () => ({})) {
    this.baseUrl = (options.baseUrl ?? "https://api.entitler.dev").replace(/\/+$/, "");
    this.timeout = positive(options.timeout ?? 10_000, "timeout");
    this.#maxRetries = wholeNumber(options.maxRetries ?? 2, "maxRetries", 0);
    this.#maxRetryDelay = wholeNumber(options.maxRetryDelay ?? 10_000, "maxRetryDelay", 0);
    this.#staleFor = wholeNumber(options.staleFor ?? 86_400_000, "staleFor", 0);
    this.#cache = options.cache === false ? undefined : (options.cache ?? new MemoryCache());
    this.#asOf = instant(options.asOf, "Pass asOf as a valid date.");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#onError = options.onError;
    this.#credentials = credentials;
    this.#headers = headers;
  }

  get kind(): string {
    return this.#credentials.kind;
  }

  /** Passes an absorbed error to `onError`, which can never change the call's outcome. */
  report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      return;
    }
  }

  async send<T>(call: Call): Promise<Answer<T>> {
    const signal = call.options?.signal;
    signal?.throwIfAborted();
    for (const customer of call.changes ?? []) this.#bump(customer);
    const url = this.#url(call);
    const headers = this.#requestHeaders(call);
    let auth: Authorised;
    if (call.open) {
      auth = { headers: {}, kind: "key", credential: "" };
    } else {
      try {
        auth = await this.#credentials.authorise(signal);
      } catch (error) {
        const previous = this.#lastAuth;
        if (!(error instanceof TokenError) || !call.cached || !this.#cache || !previous) throw error;
        const kept = await this.#get(this.#cache, await this.#key(call, url, headers, previous));
        if (!kept || Date.now() - kept.receivedAt >= this.#staleFor) throw error;
        this.report(error);
        return { data: this.#decode<T>(kept.body), stale: true };
      }
      this.#lastAuth = auth;
    }
    if (!call.cached || !this.#cache) {
      const received = await this.#exchange(call, url, headers, auth);
      return { data: this.#decode<T>(received.text, received), stale: false };
    }
    return this.#cached<T>(call, url, headers, auth, this.#cache);
  }

  async #cached<T>(
    call: Call,
    url: string,
    headers: Record<string, string>,
    auth: Authorised,
    cache: CacheStore,
  ): Promise<Answer<T>> {
    const key = await this.#key(call, url, headers, auth);
    const started = Date.now();
    const generation = this.#generationOf(call.customer);
    const kept = await this.#get(cache, key);
    const usable = kept !== undefined && Date.now() - kept.receivedAt < this.#staleFor;
    if (kept && this.#fresh(kept, call.customer)) return { data: this.#decode<T>(kept.body), stale: false };
    if (usable && (Date.now() < this.#downUntil || (this.#downUntil > 0 && this.#probing))) {
      return { data: this.#decode<T>(kept.body), stale: true };
    }
    if (kept?.etag) headers["If-None-Match"] = kept.etag;
    const probe = this.#downUntil > 0;
    if (probe) this.#probing = true;
    let received: Received;
    let data: T;
    try {
      received = await this.#exchange(call, url, headers, auth);
      if (received.status === 304 && !kept) throw apiError(received, undefined);
      data = this.#decode<T>(kept && received.status === 304 ? kept.body : received.text, received);
      this.#downUntil = 0;
    } catch (error) {
      if (isUnreachable(error)) {
        const retryAfter = error instanceof ApiError ? (error.retryAfter ?? 0) : 0;
        this.#downUntil = Date.now() + Math.max(30_000, retryAfter);
      }
      if (usable && isUnreachable(error)) {
        this.report(error);
        return { data: this.#decode<T>(kept.body), stale: true };
      }
      throw error;
    } finally {
      if (probe) this.#probing = false;
    }
    const receivedAt = this.#generationOf(call.customer) === generation ? Date.now() : started;
    const entry: CacheEntry =
      received.status === 304 && kept
        ? {
            v: 1,
            body: kept.body,
            ...optional("etag", received.headers.get("etag") ?? kept.etag),
            ...optional("cacheControl", received.headers.get("cache-control") ?? kept.cacheControl),
            ...optional(
              "age",
              ageOf(received.headers) ?? (received.headers.has("cache-control") ? undefined : kept.age),
            ),
            receivedAt,
          }
        : {
            v: 1,
            body: received.text,
            ...optional("etag", received.headers.get("etag") ?? undefined),
            ...optional("cacheControl", received.headers.get("cache-control") ?? undefined),
            ...optional("age", ageOf(received.headers)),
            receivedAt,
          };
    if (
      !directive(entry.cacheControl, "no-store") &&
      (entry.etag !== undefined || maxAgeOf(entry.cacheControl) !== undefined)
    ) {
      await this.#set(cache, key, entry);
    }
    return { data, stale: false };
  }

  async #key(call: Call, url: string, headers: Record<string, string>, auth: Authorised): Promise<string> {
    return sha256Hex(
      JSON.stringify([
        "entitler-cache-v1",
        call.method,
        url,
        auth.kind,
        await fingerprint(auth.credential),
        headers["Entitler-As-Of"] ?? null,
        headers["Entitler-Visitor"] ?? null,
      ]),
    );
  }

  #generationOf(customer: string | undefined): number {
    return customer === undefined ? 0 : (this.#generations.get(customer)?.generation ?? 0);
  }

  #bump(customer: string): void {
    this.#generations.set(customer, { generation: this.#generationOf(customer) + 1, at: Date.now() });
  }

  #fresh(entry: CacheEntry, customer: string | undefined): boolean {
    const maxAge = maxAgeOf(entry.cacheControl);
    if (maxAge === undefined || directive(entry.cacheControl, "no-cache")) return false;
    if ((Date.now() - entry.receivedAt) / 1000 + (entry.age ?? 0) >= maxAge) return false;
    const bumped = customer === undefined ? undefined : this.#generations.get(customer)?.at;
    return bumped === undefined || bumped < entry.receivedAt;
  }

  async #get(cache: CacheStore, key: string): Promise<CacheEntry | undefined> {
    try {
      const entry = await cache.get(key);
      return entry && entry.v === 1 && typeof entry.body === "string" && typeof entry.receivedAt === "number"
        ? entry
        : undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  async #set(cache: CacheStore, key: string, entry: CacheEntry): Promise<void> {
    try {
      await cache.set(key, entry, this.#staleFor + (maxAgeOf(entry.cacheControl) ?? 0) * 1000);
    } catch (error) {
      this.report(error);
    }
  }

  #decode<T>(text: string, received?: Received): T {
    try {
      const data = parseAnswer(text);
      if (data === null || typeof data !== "object") throw new TypeError("The answer is not a JSON object.");
      return data as T;
    } catch (cause) {
      throw new ApiError({
        status: received?.status ?? 200,
        code: "invalid_response",
        message: "Entitler sent an answer this SDK cannot read.",
        requestId: received?.headers.get("x-request-id") ?? undefined,
        cause,
      });
    }
  }

  #url(call: Call): string {
    const query = Object.entries(call.query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined);
    const search = query.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
    return `${this.baseUrl}${call.path}${search ? `?${search}` : ""}`;
  }

  #requestHeaders(call: Call): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", ...(call.open ? {} : this.#headers()) };
    if (RUNTIME) headers["User-Agent"] = `entitler-typescript/${VERSION} ${RUNTIME}`;
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey;
    if (this.#asOf && !call.open) headers["Entitler-As-Of"] = this.#asOf;
    for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
    return headers;
  }

  async #exchange(call: Call, url: string, headers: Record<string, string>, auth: Authorised): Promise<Received> {
    const signal = call.options?.signal;
    const timeout = positive(call.options?.timeout ?? this.timeout, "timeout");
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    let refreshed = false;
    let current = auth;
    for (let retry = 0; ; ) {
      let failure: EntitlerError;
      try {
        const received = await this.#attempt(
          url,
          call.method,
          { ...headers, ...current.headers },
          body,
          signal,
          timeout,
          call,
        );
        if (!received.redirect && (received.status < 300 || received.status === 304)) return received;
        failure = apiError(received, call.idempotencyKey);
        if (received.redirect) throw failure;
        if (received.status === 401 && !refreshed && !call.open && this.#credentials.refresh) {
          refreshed = true;
          const next = await this.#credentials.refresh(current, signal);
          if (next) {
            current = next;
            this.#lastAuth = next;
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
        redirect: "manual",
        ...(bypassesHttpCache() ? { cache: "no-store" as const } : {}),
        ...(body === undefined ? {} : { body }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400 && response.status !== 304)
      ) {
        void response.body?.cancel().catch(() => undefined);
        return { status: response.status, headers: response.headers, text: "", redirect: true };
      }
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

function optional<K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [name]: value }) as { [P in K]?: V };
}
