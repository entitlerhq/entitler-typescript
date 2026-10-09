import type { CacheStore } from "./cache.js";
import { type PricingOptions, type ServerCustomer, ServerCustomerApi, usageAmount, usageLog } from "./customer.js";
import { type ClientDescription, describe, knownScopes } from "./describe.js";
import { ApiError, TimeoutError } from "./errors.js";
import { paged } from "./paging.js";
import { type SnapshotExpectation, type VerifiedSnapshot, verifySnapshot } from "./snapshot.js";
import {
  type CallOptions,
  type ClientOptions,
  isClosed,
  type ReadOptions,
  Transport,
  type WriteOptions,
} from "./transport.js";
import type {
  CustomerDetails,
  CustomerPage,
  CustomerSummary,
  FeatureList,
  Page,
  Paged,
  Pricing,
  Replayed,
  Scopes,
  SnapshotKeys,
  UsageBatchResult,
  UsageEvent,
  UsageEventInput,
  UsageEventResult,
} from "./types.js";
import {
  compact,
  featureKey,
  idempotencyKeyOf,
  instant,
  requiredKey,
  requireId,
  requireText,
  sha256Hex,
  trimCredential,
} from "./util.js";
import { newVisitorId, visitorOf } from "./visitor.js";

/** Options for {@link EntitlerServer}. */
export interface ServerOptions extends ClientOptions {
  /** A secret project key from the dashboard. Keep it on your servers; never ship it in an app. */
  key: string;
  /**
   * Where to keep answers: a {@link MemoryCache} of another size, any {@link CacheStore} (Workers KV,
   * Redis) to share answers between processes, or `false` for none. Defaults to a
   * {@link MemoryCache} of 1,000 answers.
   */
  cache?: CacheStore | false;
}

/** Options for {@link EntitlerServer.customers}' `list`. */
export interface ListCustomersOptions extends CallOptions {
  /** Searches names, emails and external ids. */
  q?: string;
  /** Only customers in this cohort. */
  cohort?: string;
  /** Only customers on this track. */
  track?: string;
  /** Includes test customers. */
  includeTest?: boolean;
  /** Starts at the page a previous page's `next` names, so a stateless admin page can link to page 3. */
  cursor?: string;
}

/** A customer to create with {@link EntitlerServer.customers}' `create`. */
export interface CustomerCreate {
  /** The id your app uses for the customer. */
  externalId: string;
  /** The customer's name. */
  name: string;
  /** The customer's email. */
  email?: string;
  /** The plan to start on, by key or public id. */
  plan?: string;
  /** The billing period's key. */
  period?: string;
  /** The vendor's metadata. */
  metadata?: Record<string, string>;
}

/** Options for {@link EntitlerServer.recordUsageBatch}. Each request's idempotency key derives from its events. */
export interface UsageBatchOptions extends CallOptions {
  /** Registers customers not registered yet. */
  register?: boolean;
}

/** The customer list and creation. */
export interface Customers {
  /** Every customer matching the options, a page at a time. */
  list(options?: ListCustomersOptions): Paged<CustomerSummary, CustomerPage>;
  /** Creates a customer, optionally on a plan. */
  create(input: CustomerCreate, options?: WriteOptions): Promise<CustomerDetails & Replayed>;
}

const BATCH_SIZE = 500;

interface Prepared {
  readonly event?: { customer: string; feature: string; amount: number; occurredAt?: string; idempotencyKey: string };
  readonly refused?: { code: string; message: string; idempotencyKey: string | null };
}

function prepare(event: UsageEventInput): Prepared {
  const given = (event ?? {}) as Partial<Record<keyof UsageEventInput, unknown>>;
  const idempotencyKey = typeof given.idempotencyKey === "string" ? given.idempotencyKey : null;
  const step = (code: string, check: () => unknown) => {
    try {
      return { value: check() };
    } catch (error) {
      return { refused: { code, message: (error as Error).message, idempotencyKey } };
    }
  };
  const checks = [
    step("invalid_body", () => requireId(given.customer, "Provide the id your app uses for the customer.")),
    step("invalid_body", () => featureKey(given.feature as string)),
    step("invalid_amount", () => usageAmount(given.amount)),
    step("invalid_body", () => instant(given.occurredAt as string | undefined, "Pass occurredAt as a valid date.")),
    step("invalid_idempotency_key", () => requiredKey(given.idempotencyKey)),
  ];
  const refused = checks.find((check) => check.refused)?.refused;
  if (refused) return { refused };
  const [customer, feature, amount, occurredAt, key] = checks.map((check) => check.value);
  return {
    event: {
      customer: customer as string,
      feature: feature as string,
      amount: amount as number,
      ...compact({ occurredAt: occurredAt as string | undefined }),
      idempotencyKey: key as string,
    },
  };
}

async function batchKey(register: boolean, events: readonly NonNullable<Prepared["event"]>[]): Promise<string> {
  const rows = events.map((event) => [
    event.customer,
    event.feature,
    event.amount,
    event.occurredAt ?? null,
    event.idempotencyKey,
  ]);
  return `batch:${await sha256Hex(JSON.stringify(["entitler-batch-v1", register, rows]))}`;
}

function errorOf(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof ApiError ? error.code : error instanceof TimeoutError ? "timed_out" : "connection_failed",
    message: error instanceof Error ? error.message : "Entitler could not record these events.",
  };
}

/**
 * The server client, built from a secret project key. It runs on your servers and acts on any
 * customer.
 *
 * @example
 * ```ts
 * const server = new EntitlerServer({ key: process.env.ENTITLER_KEY });
 * const customer = server.customer("user_123");
 * await customer.register({ name: "Ada", email: "ada@example.com" });
 * if (await customer.isEntitled(features.exportPdf, { default: false })) exportPdf();
 * await customer.recordUsage(features.aiCredits, 3, { idempotencyKey: job.id });
 * ```
 */
export class EntitlerServer {
  readonly #transport: Transport;
  /** The customer list and creation. */
  readonly customers: Customers;

  /** Creates a server client. Throws `TypeError` for a blank key, and for a publishable key, which belongs in an app. */
  constructor(options: ServerOptions) {
    const key = requireText(options?.key, "Provide an Entitler API key from the dashboard.");
    if (trimCredential(key).startsWith("ent_pk_")) {
      throw new TypeError(
        "A publishable key belongs in EntitlerClient. Use a secret key from the dashboard on your server.",
      );
    }
    this.#transport = new Transport(options, {
      kind: "server",
      authorise: async () => ({ headers: { Authorization: `Bearer ${key}` }, kind: "key", credential: key }),
    });
    const transport = this.#transport;
    this.customers = {
      list: (list = {}) =>
        paged<CustomerSummary, CustomerPage>(async (next) => {
          const cursor = next ?? list.cursor;
          const answer = await transport.send<CustomerPage>({
            method: "GET",
            path: "/customers",
            query: {
              q: list.q,
              cohort: list.cohort,
              track: list.track,
              includeTest: list.includeTest === true ? "true" : undefined,
              cursor,
            },
            options: list,
          });
          const { items, next: following, used, limit } = answer.data;
          return { items, next: following, used, limit };
        }),
      create: async (input, options) => {
        const externalId = requireId(input?.externalId, "Provide the id your app uses for the customer.");
        const body = compact({ ...input, externalId, name: requireText(input?.name, "Provide the customer's name.") });
        const answer = await transport.send<CustomerDetails & { usage: Page<UsageEvent> }>({
          method: "POST",
          path: "/customers",
          body,
          idempotencyKey: idempotencyKeyOf(options?.idempotencyKey),
          changes: [`/customers/${encodeURIComponent(externalId)}`],
          options,
        });
        const customer = new ServerCustomerApi(transport, externalId);
        return {
          ...answer.data,
          usage: usageLog(answer.data.usage, (cursor) => customer.usagePage(cursor, options)),
          replayed: answer.replayed,
        };
      },
    };
  }

  /** The customer with the id your app uses for them. Makes no request. */
  customer(id: string): ServerCustomer {
    return new ServerCustomerApi(this.#transport, requireId(id, "Provide the id your app uses for the customer."));
  }

  /**
   * Records many usage events in `observe` mode, each under its own required idempotency key, in
   * requests of at most 500 events sent in order. Answers one result per event, in input order, and
   * the totals. An event the SDK refuses itself is answered `error` and not sent; a request that
   * fails after its retries answers its events `error` (code `connection_failed` or `timed_out`
   * when no answer arrived) and the next request still goes. Each request's idempotency key derives
   * from its events, so resending the events answered `error` is always safe. Only cancellation
   * rejects.
   */
  async recordUsageBatch(events: readonly UsageEventInput[], options?: UsageBatchOptions): Promise<UsageBatchResult> {
    if (!Array.isArray(events)) throw new TypeError("Pass events as an array.");
    this.#transport.ensureOpen();
    const register = options?.register === true;
    const prepared = events.map(prepare);
    const results: UsageEventResult[] = new Array(prepared.length);
    const totals = { recorded: 0, duplicates: 0, errors: 0 };
    const sendable: number[] = [];
    for (const [index, item] of prepared.entries()) {
      if (item.event) {
        sendable.push(index);
        continue;
      }
      const { code, message, idempotencyKey } = item.refused as NonNullable<Prepared["refused"]>;
      results[index] = {
        index,
        outcome: "error",
        id: null,
        late: false,
        error: { code, message },
        idempotencyKey,
        replayed: false,
      };
      totals.errors += 1;
    }
    for (let start = 0; start < sendable.length; start += BATCH_SIZE) {
      const indexes = sendable.slice(start, start + BATCH_SIZE);
      const chunk = indexes.map((index) => prepared[index]?.event as NonNullable<Prepared["event"]>);
      let answer: UsageBatchResult;
      let replayed = false;
      try {
        const sent = await this.#transport.send<UsageBatchResult>({
          method: "POST",
          path: "/usage/events",
          body: { ...(options?.register === undefined ? {} : { register: options.register }), events: chunk },
          idempotencyKey: await batchKey(register, chunk),
          changes: chunk.map((event) => `/customers/${encodeURIComponent(event.customer)}`),
          options,
        });
        answer = sent.data;
        replayed = sent.replayed;
      } catch (error) {
        if ((options?.signal?.aborted && error === options.signal.reason) || isClosed(error)) throw error;
        const failure = errorOf(error);
        answer = {
          results: chunk.map((_, index) => ({
            index,
            outcome: "error",
            id: null,
            late: false,
            error: failure,
            idempotencyKey: null,
            replayed: false,
          })),
          recorded: 0,
          duplicates: 0,
          errors: chunk.length,
        };
      }
      for (const result of answer.results) {
        const index = indexes[result.index] as number;
        results[index] = { ...result, index, idempotencyKey: chunk[result.index]?.idempotencyKey ?? null, replayed };
      }
      totals.recorded += answer.recorded;
      totals.duplicates += answer.duplicates;
      totals.errors += answer.errors;
    }
    return { results, ...totals };
  }

  /** The pricing on sale, signed out, through the answer cache. Pass a visitor id to keep their experiment arm. */
  async pricing(options?: PricingOptions): Promise<Pricing> {
    const answer = await this.#transport.send<Pricing>({
      method: "GET",
      path: "/pricing",
      cached: true,
      revalidate: options?.revalidate,
      headers: { "Entitler-Visitor": visitorOf(options?.visitor) },
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  /** The catalogue's features, through the answer cache. */
  async features(options?: ReadOptions): Promise<FeatureList> {
    const answer = await this.#transport.send<FeatureList>({
      method: "GET",
      path: "/pricing/features",
      cached: true,
      revalidate: options?.revalidate,
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  /** The scopes this client's key holds, asked afresh on each call. */
  async scopes(options?: CallOptions): Promise<Scopes> {
    const answer = await this.#transport.send<{ scopes: string[] }>({ method: "GET", path: "/keys/self", options });
    return { scopes: knownScopes(answer.data.scopes) };
  }

  /** The public keys that verify snapshots. Sends no credential. */
  async snapshotKeys(options?: CallOptions): Promise<SnapshotKeys> {
    return (
      await this.#transport.send<SnapshotKeys>({ method: "GET", path: "/customers/snapshot-keys", open: true, options })
    ).data;
  }

  /** Verifies a snapshot offline, with no request. See {@link verifySnapshot}. */
  async verifySnapshot(token: string, expected: SnapshotExpectation): Promise<VerifiedSnapshot> {
    return verifySnapshot(token, expected);
  }

  /** Mints a new visitor id. See {@link newVisitorId}. */
  newVisitorId(): string {
    return newVisitorId();
  }

  /**
   * Closes the client: aborts every call in flight, drops the in-memory cache (a custom store is
   * left as it is), and makes every later call reject with a `DOMException` named
   * `InvalidStateError`. Closing twice is safe.
   */
  close(): void {
    this.#transport.close();
  }

  /** Shows the base URL and the kind, never the key. */
  toString(): string {
    return describe("EntitlerServer", this.#transport);
  }

  /** Shows the base URL and the kind, never the key. */
  toJSON(): ClientDescription<"server"> {
    return { baseUrl: this.#transport.baseUrl, kind: "server" };
  }

  /** Shows the base URL and the kind in Node's `console.log`, never the key. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
