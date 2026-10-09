/** A value, or a promise of one, so a cache store can be synchronous or not. */
export type MaybePromise<T> = T | Promise<T>;

/** One kept answer. Plain JSON-ready data, so any store can keep it. */
export interface CacheEntry {
  /** The entry format's version, `1`. */
  readonly v: 1;
  /** The answer body, as the JSON text Entitler sent. */
  readonly body: string;
  /** The answer's `ETag`, for revalidating it. */
  readonly etag?: string;
  /** The answer's `Cache-Control` directives, such as `private, max-age=60`. */
  readonly cacheControl?: string;
  /** The answer's `Age` header, in seconds: how old it already was when it arrived. */
  readonly age?: number;
  /** When the answer was received, in milliseconds since the epoch. */
  readonly receivedAt: number;
}

/**
 * Where a client keeps answers: the default {@link MemoryCache}, or your own store, such as
 * Workers KV or Redis, to share answers between processes or keep them across app launches.
 * Keys are SHA-256 hashes and never contain a credential. A `get` that fails counts as a miss and
 * a `set` that fails is skipped; both go to `onError` and neither fails the call.
 *
 * @example
 * ```ts
 * const redisCache: CacheStore = {
 *   async get(key) {
 *     const text = await redis.get(`entitler:${key}`);
 *     return text ? JSON.parse(text) : undefined;
 *   },
 *   async set(key, entry, ttl) {
 *     await redis.set(`entitler:${key}`, JSON.stringify(entry), { PX: ttl });
 *   },
 * };
 * ```
 */
export interface CacheStore {
  /** Answers the entry kept under `key`, or `undefined`. */
  get(key: string): MaybePromise<CacheEntry | undefined>;
  /**
   * Keeps `entry` under `key`, replacing any entry there. `ttl` is how long the entry stays
   * useful, in milliseconds (`staleFor` plus its `max-age`), for stores that expire entries; other
   * stores should drop entries after that time. Entries are private to this SDK.
   */
  set(key: string, entry: CacheEntry, ttl: number): MaybePromise<void>;
}

/** Options for a {@link MemoryCache}. */
export interface MemoryCacheOptions {
  /** How many answers to keep before the least recently used goes. Defaults to 1,000. */
  maxEntries?: number;
}

/** An in-memory {@link CacheStore} that drops the least recently used answer when full. */
export class MemoryCache implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxEntries: number;

  /** Creates a store holding at most `maxEntries` answers. */
  constructor({ maxEntries = 1000 }: MemoryCacheOptions = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("Pass maxEntries as a whole number of 1 or more.");
    }
    this.#maxEntries = maxEntries;
  }

  /** Answers the entry kept under `key`, and marks it as recently used. */
  get(key: string): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  /** Keeps `entry` under `key`, dropping the least recently used entry when full. */
  set(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value as string);
    }
  }
}
