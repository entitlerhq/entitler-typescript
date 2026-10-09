import { type ServerCustomer, ServerCustomerApi, usageAmount, usageLog } from "./customer.js";
import { type ClientDescription, describe, knownScopes } from "./describe.js";
import { ApiError, TimeoutError } from "./errors.js";
import { paged } from "./paging.js";
import { type ExpectedSnapshot, type VerifiedSnapshot, verifySnapshot } from "./snapshot.js";
import { type CallOptions, type ClientOptions, Transport, type WriteOptions } from "./transport.js";
import type {
  CustomerDetails,
  CustomerSummary,
  FeatureList,
  Page,
  Paged,
  Pricing,
  Scopes,
  SnapshotKeys,
  UsageBatchResult,
  UsageEvent,
  UsageEventInput,
  UsageEventResult,
} from "./types.js";
import { compact, featureKey, idempotencyKeyOf, instant, requireId, requireText } from "./util.js";
import { newVisitorId, visitorOf } from "./visitor.js";

/** Options for {@link EntitlerServer}. */
export interface ServerOptions extends ClientOptions {
  /** A secret project key from the dashboard. Keep it on your servers; never ship it in an app. */
  key: string;
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

/** Options for {@link EntitlerServer.recordUsageBatch}. */
export interface UsageBatchOptions extends WriteOptions {
  /** Registers customers not registered yet. */
  register?: boolean;
}

/** The customer list and creation. */
export interface Customers {
  /** Every customer matching the options, a page at a time. */
  list(options?: ListCustomersOptions): Paged<CustomerSummary>;
  /** Creates a customer, optionally on a plan. */
  create(input: CustomerCreate, options?: WriteOptions): Promise<CustomerDetails>;
}

const BATCH_SIZE = 500;

function failedRequest(count: number, error: unknown): UsageBatchResult {
  const code =
    error instanceof ApiError ? error.code : error instanceof TimeoutError ? "timed_out" : "connection_failed";
  const message = error instanceof Error ? error.message : "Entitler could not record these events.";
  return {
    results: Array.from({ length: count }, (_, index) => ({
      index,
      outcome: "error",
      id: null,
      late: false,
      error: { code, message },
      idempotencyKey: "",
    })),
    recorded: 0,
    duplicates: 0,
    errors: count,
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

  /** Creates a server client. Throws `TypeError` for a blank key. */
  constructor(options: ServerOptions) {
    const key = requireText(options?.key, "Provide an Entitler API key from the dashboard.");
    this.#transport = new Transport(options, {
      kind: "server",
      authorise: async () => ({ headers: { Authorization: `Bearer ${key}` }, kind: "key", credential: key }),
    });
    const transport = this.#transport;
    this.customers = {
      list: (list = {}) =>
        paged(async (cursor) => {
          const answer = await transport.send<Page<CustomerSummary>>({
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
          return { items: answer.data.items, next: answer.data.next };
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
        return { ...answer.data, usage: usageLog(answer.data.usage, (cursor) => customer.usagePage(cursor, options)) };
      },
    };
  }

  /** The customer with the id your app uses for them. Makes no request. */
  customer(id: string): ServerCustomer {
    return new ServerCustomerApi(this.#transport, requireId(id, "Provide the id your app uses for the customer."));
  }

  /**
   * Records many usage events in `observe` mode, in requests of at most 500 events sent in order.
   * Answers one result per event, in input order, each with its idempotency key, and the totals.
   * A request that fails after its retries answers its events with outcome `error` (code
   * `connection_failed` or `timed_out` when no answer arrived) and the next request still goes:
   * resend those events with the same keys. Keys derived from your own unit of work make any resend
   * safe. Only argument errors and cancellation reject.
   */
  async recordUsageBatch(events: readonly UsageEventInput[], options?: UsageBatchOptions): Promise<UsageBatchResult> {
    if (!Array.isArray(events)) throw new TypeError("Pass events as an array.");
    const prepared = events.map(
      (event) =>
        compact({
          customer: requireId(event?.customer, "Provide the id your app uses for the customer."),
          feature: featureKey(event.feature),
          amount: event.amount === undefined ? undefined : usageAmount(event.amount),
          occurredAt: instant(event.occurredAt, "Pass occurredAt as a valid date."),
          idempotencyKey: idempotencyKeyOf(event.idempotencyKey),
        }) as { customer: string; idempotencyKey: string },
    );
    const requests = Math.ceil(prepared.length / BATCH_SIZE);
    const keys = Array.from({ length: requests }, (_, index) =>
      options?.idempotencyKey === undefined
        ? idempotencyKeyOf(undefined)
        : `${idempotencyKeyOf(options.idempotencyKey, 190)}:${index}`,
    );
    const results: UsageEventResult[] = [];
    const totals = { recorded: 0, duplicates: 0, errors: 0 };
    for (const [request, idempotencyKey] of keys.entries()) {
      const start = request * BATCH_SIZE;
      const chunk = prepared.slice(start, start + BATCH_SIZE);
      let answer: UsageBatchResult;
      try {
        answer = (
          await this.#transport.send<UsageBatchResult>({
            method: "POST",
            path: "/usage/events",
            body: { ...compact({ register: options?.register }), events: chunk },
            idempotencyKey,
            changes: chunk.map((event) => `/customers/${encodeURIComponent(event.customer)}`),
            options,
          })
        ).data;
      } catch (error) {
        if (options?.signal?.aborted && error === options.signal.reason) throw error;
        answer = failedRequest(chunk.length, error);
      }
      for (const result of answer.results) {
        const index = start + result.index;
        results.push({
          ...result,
          index,
          idempotencyKey: (prepared[index] as { idempotencyKey: string }).idempotencyKey,
        });
      }
      totals.recorded += answer.recorded;
      totals.duplicates += answer.duplicates;
      totals.errors += answer.errors;
    }
    return { results: results.sort((a, b) => a.index - b.index), ...totals };
  }

  /** The pricing on sale, signed out, through the answer cache. Pass a visitor id to keep their experiment arm. */
  async pricing(options?: CallOptions & { visitor?: string }): Promise<Pricing> {
    const answer = await this.#transport.send<Pricing>({
      method: "GET",
      path: "/pricing",
      cached: true,
      headers: { "Entitler-Visitor": visitorOf(options?.visitor) },
      options,
    });
    return { ...answer.data, stale: answer.stale };
  }

  /** The catalogue's features, through the answer cache. */
  async features(options?: CallOptions): Promise<FeatureList> {
    const answer = await this.#transport.send<FeatureList>({
      method: "GET",
      path: "/pricing/features",
      cached: true,
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
  async verifySnapshot(token: string, expected: ExpectedSnapshot): Promise<VerifiedSnapshot> {
    return verifySnapshot(token, expected);
  }

  /** Mints a new visitor id. See {@link newVisitorId}. */
  newVisitorId(): string {
    return newVisitorId();
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
