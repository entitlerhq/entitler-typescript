import { type CacheEntry, type CacheStore, MemoryCache } from "./cache.js";
import { ApiError, ConnectionError, type EntitlerError, grpcCode, isUnreachable, TimeoutError } from "./errors.js";
import type { Decoder } from "./shapes.js";
import {
  deadlineAfter,
  encode,
  redacted,
  saturated,
  sha256Hex,
  sleep,
  summaryOf,
  untilAborted,
  wholeNumber,
} from "./util.js";
import { VERSION } from "./version.js";

/** Options both clients take. */
export interface ClientOptions {
  /** The API's base URL. Defaults to `https://api.entitler.app`. */
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
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
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
  refuse?(used: Authorised): void;
}

/** One request. @internal */
export interface Call {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string | undefined>;
  readonly idempotencyKey?: string;
  readonly retryable?: boolean;
  readonly cached?: boolean;
  readonly customer?: string;
  readonly revalidate?: boolean | undefined;
  readonly decode: Decoder;
  readonly open?: boolean;
  readonly empty?: boolean;
  readonly options?: CallOptions | undefined;
}

/** An answer, whether it came from a kept copy, and whether it answered a retry. @internal */
export interface Answer<T> {
  readonly data: T;
  readonly stale: boolean;
  readonly retried?: boolean;
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
  readonly retried?: boolean;
  readonly auth?: Authorised;
}

/** The options each client adds to {@link ClientOptions}, resolved. @internal */
export interface TransportOptions extends ClientOptions {
  readonly cache?: CacheStore | false | undefined;
}

const RETRIED = new Set([408, 429, 500, 502, 503, 504]);

/** Parses an answer body as plain JSON; each call's decoder turns its instants into `Date`s. @internal */
export function parseAnswer(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("The answer is not valid JSON.");
  }
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
  if (/^\d+$/.test(value)) return Math.min(saturated(value) * 1000, Number.MAX_SAFE_INTEGER);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function directive(control: string | undefined, name: string): boolean {
  return new RegExp(`(^|[\\s,])${name}($|[\\s,=])`, "i").test(control ?? "");
}

function maxAgeOf(control: string | undefined): number | undefined {
  const maxAge = /(?:^|[\s,])max-age=(\d+)/i.exec(control ?? "")?.[1];
  return maxAge === undefined ? undefined : saturated(maxAge);
}

function ageOf(headers: Headers): number | undefined {
  const age = headers.get("age")?.trim();
  return age && /^\d+$/.test(age) ? saturated(age) : undefined;
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
  const parameters =
    error.parameters && typeof error.parameters === "object" && !Array.isArray(error.parameters)
      ? Object.fromEntries(
          Object.entries(error.parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {};
  return new ApiError({
    status: received.status,
    code: typeof error.code === "string" && error.code !== "" ? error.code : grpcCode(received.status),
    reason: typeof error.reason === "string" && error.reason !== "" ? error.reason : null,
    parameters,
    requestId: received.headers.get("x-request-id") ?? undefined,
    retryAfter: retryAfterOf(received.headers),
    idempotencyKey,
  });
}

let noStore: boolean | undefined;

function bypassesHttpCache(): boolean {
  if (noStore === undefined) {
    try {
      new Request("https://api.entitler.app", { cache: "no-store" });
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

let keyObserver: ((key: string) => void) | undefined;

/** Test-only: observes the cache key each read through the cache asks for. Never public API. @internal */
export function observeCacheKeys(observer: ((key: string) => void) | undefined): void {
  keyObserver = observer;
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
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly #credentials: Credentials;
  readonly #headers: () => Record<string, string>;
  #downUntil = 0;
  #probing = false;
  #authorised: Authorised | undefined;

  constructor(options: TransportOptions, credentials: Credentials, headers: () => Record<string, string> = () => ({})) {
    this.baseUrl = (options.baseUrl ?? "https://api.entitler.app").replace(/\/+$/, "");
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

  /** Refuses a per-call timeout that is not a number of milliseconds above 0. @internal */
  checkTimeout(options: CallOptions | undefined): void {
    if (options?.timeout !== undefined) positive(options.timeout, "timeout");
  }

  async send<T>(given: Call): Promise<Answer<T>> {
    this.ensureOpen();
    this.checkTimeout(given.options);
    given.options?.signal?.throwIfAborted();
    this.#closing ??= new AbortController();
    const signal = given.options?.signal
      ? AbortSignal.any([given.options.signal, this.#closing.signal])
      : this.#closing.signal;
    const call: Call = { ...given, options: { ...given.options, signal } };
    return this.#answer<T>(call, signal);
  }

  async #answer<T>(call: Call, signal: AbortSignal): Promise<Answer<T>> {
    const url = this.#url(call);
    const headers = this.#requestHeaders(call);
    let auth: Authorised;
    try {
      auth = call.open
        ? { headers: {}, kind: "key", credential: "" }
        : redacted(await this.#credentials.authorise(signal));
    } catch (error) {
      const kept =
        call.cached && this.#cache && this.#authorised && isUnreachable(error)
          ? await this.#kept<T>(call, url, this.#authorised, this.#cache)
          : undefined;
      if (!kept?.usable || !kept.keptData) throw error;
      this.report(error);
      return { data: kept.keptData.data, stale: true };
    }
    if (!call.open) this.#authorised = auth;
    if (!call.cached || !this.#cache) {
      const received = await this.#exchange(call, url, headers, auth);
      if (received.status === 304) throw apiError(received, call.idempotencyKey);
      if (this.#cache && call.customer !== undefined && call.method !== "GET") {
        await this.#renew(this.#cache, received.auth ?? auth, call.customer);
      }
      return {
        data: call.empty && received.text === "" ? (undefined as T) : this.#decode<T>(received.text, received, call),
        stale: false,
        retried: received.retried === true,
      };
    }
    return this.#cached<T>(call, url, headers, auth, this.#cache);
  }

  async #kept<T>(call: Call, url: string, auth: Authorised, cache: CacheStore) {
    const key = await this.#key(call, url, auth);
    keyObserver?.(key);
    const found = await this.#get(cache, key, call.options?.signal);
    const keptData = found && this.#readKept<T>(found.body, call);
    const kept = keptData && found;
    const usable = kept !== undefined && Math.max(0, Date.now() - Math.floor(kept.receivedAt)) < this.#staleFor;
    return { key, kept, keptData, usable };
  }

  async #cached<T>(
    call: Call,
    url: string,
    headers: Record<string, string>,
    auth: Authorised,
    cache: CacheStore,
  ): Promise<Answer<T>> {
    const { key, kept, keptData, usable } = await this.#kept<T>(call, url, auth, cache);
    if (kept && keptData && !call.revalidate && this.#fresh(kept)) {
      return { data: keptData.data, stale: false };
    }
    if (usable && keptData && (Date.now() < this.#downUntil || (this.#downUntil > 0 && this.#probing))) {
      return { data: keptData.data, stale: true };
    }
    if (kept?.etag) headers["If-None-Match"] = kept.etag;
    const probe = this.#downUntil > 0;
    if (probe) this.#probing = true;
    let received: Received;
    let data: T;
    try {
      received = await this.#exchange(call, url, headers, auth);
      if (received.status === 304 && !kept) throw apiError(received, undefined);
      data = keptData && received.status === 304 ? keptData.data : this.#decode<T>(received.text, received, call);
      this.#downUntil = 0;
    } catch (error) {
      if (isUnreachable(error) && !(error instanceof ApiError && error.reason === "RESPONSE_INVALID")) {
        const retryAfter = error instanceof ApiError ? (error.retryAfter ?? 0) : 0;
        this.#downUntil = Date.now() + Math.min(Math.max(30_000, retryAfter), this.#staleFor);
      }
      if (usable && keptData && isUnreachable(error)) {
        this.report(error);
        return { data: keptData.data, stale: true };
      }
      throw error;
    } finally {
      if (probe) this.#probing = false;
    }
    const receivedAt = Date.now();
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
      await this.#set(
        cache,
        received.auth ? await this.#key(call, url, received.auth) : key,
        entry,
        call.options?.signal,
      );
    }
    return { data, stale: false };
  }

  async #generationKey(auth: Authorised, customer: string): Promise<string> {
    return sha256Hex(
      JSON.stringify(["entitler-generation-v1", auth.kind, await fingerprint(auth.credential), customer]),
    );
  }

  async #generation(cache: CacheStore, auth: Authorised, customer: string, signal: AbortSignal | undefined) {
    const found = await this.#get(cache, await this.#generationKey(auth, customer), signal);
    return found?.body ?? (await this.#renew(cache, auth, customer, signal));
  }

  async #renew(cache: CacheStore, auth: Authorised, customer: string, signal?: AbortSignal): Promise<string> {
    const generation = crypto.randomUUID();
    const entry: CacheEntry = { v: 1, body: generation, receivedAt: Date.now() };
    await this.#set(cache, await this.#generationKey(auth, customer), entry, signal);
    return generation;
  }

  async #key(call: Call, url: string, auth: Authorised): Promise<string> {
    const generation =
      call.customer !== undefined && this.#cache
        ? await this.#generation(this.#cache, auth, call.customer, call.options?.signal)
        : null;
    return sha256Hex(
      JSON.stringify([
        "entitler-cache-v1",
        call.method,
        url,
        auth.kind,
        await fingerprint(auth.credential),
        generation,
        Object.entries(call.headers ?? {})
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      ]),
    );
  }

  #fresh(entry: CacheEntry): boolean {
    const maxAge = maxAgeOf(entry.cacheControl);
    if (maxAge === undefined || directive(entry.cacheControl, "no-cache")) return false;
    return Math.max(0, Date.now() - Math.floor(entry.receivedAt)) / 1000 + (entry.age ?? 0) < maxAge;
  }

  async #get(cache: CacheStore, key: string, signal: AbortSignal | undefined): Promise<CacheEntry | undefined> {
    try {
      const entry = await untilAborted(
        Promise.resolve().then(() => cache.get(key)),
        signal,
      );
      return entry && entry.v === 1 && typeof entry.body === "string" && typeof entry.receivedAt === "number"
        ? entry
        : undefined;
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      this.report(error);
      return undefined;
    }
  }

  async #set(cache: CacheStore, key: string, entry: CacheEntry, signal: AbortSignal | undefined): Promise<void> {
    try {
      const ttl = this.#staleFor + (maxAgeOf(entry.cacheControl) ?? 0) * 1000;
      await untilAborted(
        Promise.resolve().then(() => cache.set(key, entry, Math.min(ttl, Number.MAX_SAFE_INTEGER))),
        signal,
      );
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      this.report(error);
    }
  }

  #readKept<T>(body: string, call: Call): { data: T } | undefined {
    try {
      return { data: this.#decode<T>(body, undefined, call) };
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  #decode<T>(text: string, received: Received | undefined, call: Call): T {
    try {
      const data = parseAnswer(text);
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new TypeError("The answer is not a JSON object.");
      }
      return call.decode(data) as T;
    } catch (cause) {
      throw new ApiError({
        status: received?.status ?? 200,
        code: "Internal",
        reason: "RESPONSE_INVALID",
        requestId: received?.headers.get("x-request-id") ?? undefined,
        idempotencyKey: received ? call.idempotencyKey : undefined,
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
    for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
    return headers;
  }

  async #exchange(call: Call, url: string, headers: Record<string, string>, auth: Authorised): Promise<Received> {
    const signal = call.options?.signal;
    const timeout = positive(call.options?.timeout ?? this.timeout, "timeout");
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    let current = auth;
    let refreshed = false;
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
        if (!received.redirect && (received.status < 300 || received.status === 304)) {
          this.#downUntil = 0;
          return { ...received, ...(retry === 0 ? {} : { retried: true }), ...(refreshed ? { auth: current } : {}) };
        }
        const refused = apiError(received, call.idempotencyKey);
        failure = refused;
        if (received.redirect) throw failure;
        if (received.status === 401 && this.#credentials.refuse && !call.open) {
          this.#credentials.refuse(current);
          if (refreshed) throw failure;
          refreshed = true;
          current = redacted(await this.#credentials.authorise(signal));
          continue;
        }
        if (!(RETRIED.has(received.status) || refused.code === "Aborted") || !retryable(call)) throw failure;
      } catch (error) {
        if (!(error instanceof ConnectionError || error instanceof TimeoutError) || !retryable(call)) throw error;
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
    const deadline = deadlineAfter(timeout);
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
          cause: summaryOf(cause),
          idempotencyKey: call.idempotencyKey,
        });
      }
      throw new ConnectionError("Entitler could not be reached.", {
        cause: summaryOf(cause),
        idempotencyKey: call.idempotencyKey,
      });
    }
  }
}

function retryable(call: Call): boolean {
  return call.retryable ?? (call.method === "GET" || call.method === "PUT" || call.method === "DELETE");
}

function optional<K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [name]: value }) as { [P in K]?: V };
}
