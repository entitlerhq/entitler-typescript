import { type CacheEntry, type CacheStore, MemoryCache } from "./cache.js";
import { ApiError, ConnectionError, type EntitlerError, type ErrorCode, TimeoutError, unreachable } from "./errors.js";
import { encode, sha256Hex, sleep, wholeNumber } from "./util.js";
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
  /** How long a kept answer may stand in while Entitler is unreachable, in milliseconds. Defaults to 24 hours. */
  staleFor?: number;
  /**
   * Called with each error a fallback absorbed: a stale answer, an `isEntitled` default, a hold's
   * failed release or disposal, and a custom cache store's own failures.
   */
  onError?: (error: unknown) => void;
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

/** Options every read through the answer cache takes. */
export interface ReadOptions extends CallOptions {
  /**
   * Skips a fresh kept answer and revalidates it with its `ETag`, so a page that knows the
   * customer just changed shows the change without waiting for `max-age`.
   */
  revalidate?: boolean;
}

/** Options every write method takes. */
export interface WriteOptions extends CallOptions {
  /**
   * The idempotency key, 1 to 200 printable ASCII characters, not starting or ending with a
   * space. Name the event (this webhook delivery, this request), never an object whose state
   * changes: a key is never freed, so reusing it replays the first answer. The SDK generates one
   * when it is left out.
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
  readonly revalidate?: boolean | undefined;
  readonly shape?: (data: Record<string, unknown>) => boolean;
  readonly customer?: string;
  readonly changes?: readonly string[];
  readonly open?: boolean;
  readonly empty?: boolean;
  readonly options?: CallOptions | undefined;
}

/** An answer, and whether it came from a kept copy. @internal */
export interface Answer<T> {
  readonly data: T;
  readonly stale: boolean;
  readonly replayed: boolean;
}

const CLOSED = "This Entitler client is closed. Create a new one.";

/** The error every call of a closed client fails with. @internal */
export function closedError(): DOMException {
  return new DOMException(CLOSED, "InvalidStateError");
}

/** True for the error a closed client's calls fail with. @internal */
export function isClosed(error: unknown): boolean {
  return error instanceof DOMException && error.name === "InvalidStateError" && error.message === CLOSED;
}

interface Received {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly redirect?: boolean;
}

/** The options each client adds to {@link ClientOptions}, resolved. @internal */
export interface TransportOptions extends ClientOptions {
  readonly cache?: CacheStore | false | undefined;
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
  return JSON.parse(text, (key, value) => (DATE_KEYS.has(key) && typeof value === "string" ? instantOf(value) : value));
}

function instantOf(text: string): Date {
  const date = new Date(text);
  const year = date.getUTCFullYear();
  if (!TIMESTAMP.test(text) || Number.isNaN(date.getTime()) || year < 1 || year > 9999) {
    throw new TypeError("An instant in the answer is not an RFC 3339 timestamp from year 1 to 9999.");
  }
  return date;
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC_850 =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function httpDate(value: string): number | undefined {
  const fixed = IMF_FIXDATE.exec(value) ?? RFC_850.exec(value);
  const asctime = ASCTIME.exec(value);
  const parts = fixed
    ? fixed.slice(1)
    : asctime
      ? [asctime[2], asctime[1], asctime[6], asctime[3], asctime[4], asctime[5]]
      : [];
  const [day, month, year, hours, minutes, seconds] = parts as string[];
  const monthIndex = MONTHS.indexOf(month ?? "");
  if (monthIndex < 0 || !day || !year) return undefined;
  let fullYear = Number(year);
  if (year.length === 2) {
    const thisYear = new Date(Date.now()).getUTCFullYear();
    fullYear += Math.floor(thisYear / 100) * 100;
    if (fullYear > thisYear + 50) fullYear -= 100;
  }
  return Date.UTC(fullYear, monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds));
}

function retryAfterOf(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = httpDate(value);
  return date === undefined ? undefined : Math.max(0, date - Date.now());
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
  const error =
    !received.redirect && body && typeof body.error === "object" && body.error && !Array.isArray(body.error)
      ? body.error
      : {};
  const payment =
    received.status === 402 && error.payment && typeof error.payment === "object"
      ? (error.payment as { status?: unknown; url?: unknown })
      : undefined;
  return new ApiError({
    status: received.status,
    code: typeof error.code === "string" && error.code !== "" ? (error.code as ErrorCode) : "http_error",
    message:
      typeof error.message === "string" && error.message !== ""
        ? error.message
        : `Entitler answered with HTTP ${received.status}.`,
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
  #cache: CacheStore | undefined;
  readonly #ownsCache: boolean;
  #closing: AbortController | undefined;
  #closed = false;
  readonly #fetch: typeof fetch;
  readonly #credentials: Credentials;
  readonly #headers: () => Record<string, string>;
  readonly #generations = new Map<string, { generation: number; at: number }>();
  #downUntil = 0;
  #probing = false;

  constructor(options: TransportOptions, credentials: Credentials, headers: () => Record<string, string> = () => ({})) {
    this.baseUrl = (options.baseUrl ?? "https://api.entitler.dev").replace(/\/+$/, "");
    this.timeout = positive(options.timeout ?? 10_000, "timeout");
    this.#maxRetries = wholeNumber(options.maxRetries ?? 2, "maxRetries", 0);
    this.#maxRetryDelay = wholeNumber(options.maxRetryDelay ?? 10_000, "maxRetryDelay", 0);
    this.#staleFor = wholeNumber(options.staleFor ?? 86_400_000, "staleFor", 0);
    this.#cache = options.cache === false ? undefined : (options.cache ?? new MemoryCache());
    this.#ownsCache = options.cache === undefined || options.cache instanceof MemoryCache;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#onError = options.onError;
    this.#credentials = credentials;
    this.#headers = headers;
  }

  get kind(): string {
    return this.#credentials.kind;
  }

  /** Aborts every call in flight and the pending refresh, drops the in-memory cache, and refuses later calls. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing?.abort(closedError());
    if (this.#ownsCache) this.#cache = undefined;
  }

  /** The signal a close aborts, or `undefined` before the first call. */
  get closing(): AbortSignal | undefined {
    if (this.#closed) return AbortSignal.abort(closedError());
    return this.#closing?.signal;
  }

  /** Throws the closed error once the client is closed. */
  ensureOpen(): void {
    if (this.#closed) throw closedError();
  }

  /** Passes an absorbed error to `onError`, which can never change the call's outcome. */
  report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      return;
    }
  }

  async send<T>(given: Call): Promise<Answer<T>> {
    this.ensureOpen();
    given.options?.signal?.throwIfAborted();
    this.#closing ??= new AbortController();
    const signal = given.options?.signal
      ? AbortSignal.any([given.options.signal, this.#closing.signal])
      : this.#closing.signal;
    const call: Call = { ...given, options: { ...given.options, signal } };
    for (const customer of call.changes ?? []) this.#bump(customer);
    const url = this.#url(call);
    const headers = this.#requestHeaders(call);
    const auth: Authorised = call.open
      ? { headers: {}, kind: "key", credential: "" }
      : await this.#credentials.authorise(signal);
    if (!call.cached || !this.#cache) {
      const received = await this.#exchange(call, url, headers, auth);
      if (received.status === 304) throw apiError(received, call.idempotencyKey);
      return {
        data:
          call.empty && received.text === "" ? (undefined as T) : this.#decode<T>(received.text, received, call.shape),
        stale: false,
        replayed: received.headers.get("idempotent-replayed")?.trim().toLowerCase() === "true",
      };
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
    if (kept && !call.revalidate && this.#fresh(kept, call.customer)) {
      return { data: this.#decode<T>(kept.body), stale: false, replayed: false };
    }
    if (usable && (Date.now() < this.#downUntil || (this.#downUntil > 0 && this.#probing))) {
      return { data: this.#decode<T>(kept.body), stale: true, replayed: false };
    }
    if (kept?.etag) headers["If-None-Match"] = kept.etag;
    const probe = this.#downUntil > 0;
    if (probe) this.#probing = true;
    let received: Received;
    let data: T;
    try {
      received = await this.#exchange(call, url, headers, auth);
      if (received.status === 304 && !kept) throw apiError(received, undefined);
      data = this.#decode<T>(kept && received.status === 304 ? kept.body : received.text, received, call.shape);
      this.#downUntil = 0;
    } catch (error) {
      if (unreachable(error)) {
        const retryAfter = error instanceof ApiError ? (error.retryAfter ?? 0) : 0;
        this.#downUntil = Date.now() + Math.max(30_000, retryAfter);
      }
      if (usable && unreachable(error)) {
        this.report(error);
        return { data: this.#decode<T>(kept.body), stale: true, replayed: false };
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
    return { data, stale: false, replayed: false };
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

  #decode<T>(text: string, received?: Received, check?: (data: Record<string, unknown>) => boolean): T {
    try {
      const data = parseAnswer(text);
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new TypeError("The answer is not a JSON object.");
      }
      if (check && !check(data as Record<string, unknown>)) throw new TypeError("The answer lacks a required field.");
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
    const search = query.map(([name, value]) => `${encode(name)}=${encode(value)}`).join("&");
    return `${this.baseUrl}${call.path}${search ? `?${search}` : ""}`;
  }

  #requestHeaders(call: Call): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", ...(call.open ? {} : this.#headers()) };
    if (RUNTIME) headers["User-Agent"] = `entitler-typescript/${VERSION} ${RUNTIME}`;
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey;
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
      signal?.throwIfAborted();
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
