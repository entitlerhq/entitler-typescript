import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  MemoryCache,
  type ServerCustomer,
  SnapshotError,
  TimeoutError,
  TokenError,
  verifySnapshot,
} from "../../src/index.js";

type Case = Record<string, unknown> & { name: string; outcome: Record<string, unknown> };
type Sent = { url: string; method: string; headers: Headers; at: number };

const folder = new URL("../fixtures/conformance/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")) as {
  files: { path: string; cases: number; sha256: string }[];
};

function load(path: string): Case[] {
  return (JSON.parse(readFileSync(new URL(path, folder), "utf8")) as { cases: Case[] }).cases;
}

const CONTRADICTED: Record<string, (c: Case) => string | undefined> = {
  "cache-keys.json": (c) =>
    c.principalKind === "identity"
      ? "publishable keys start ent_pk_ (3.5), so EntitlerClient refuses this key"
      : c.asOf && (c.principalKind !== "key" || (c.built as { route: string }).route === "/pricing")
        ? "as-of is per call, on the server customer's reads only (6.6)"
        : undefined,
  "idempotency-keys.json": (c) =>
    c.method === "recordUsageBatch"
      ? "recordUsageBatch takes no key: each request's key derives from its events (5.2)"
      : c.method === "batchEvent" && c.outcome.kind
        ? "an invalid event key is answered error, not thrown (5.2)"
        : undefined,
};

function conformance(path: string, test: (c: Case) => unknown) {
  for (const c of load(path)) {
    const reason = CONTRADICTED[path]?.(c);
    if (reason) it.skip(`${c.name} (contradicts the spec: ${reason})`, () => {});
    else
      it(c.name, async () => {
        await test(c);
      });
  }
}

const BODY = {
  customer: "user_42",
  asOf: "2026-07-01T09:30:00.000Z",
  feature: "export_pdf",
  type: "boolean",
  entitled: true,
  value: true,
  sources: [],
  upgrades: [],
  environment: { id: "env_conformance_test", name: "Development", kind: "test" },
  track: { id: "trk_all_customers", name: "All customers" },
  release: 2,
  change: null,
  testers: true,
  experiment: null,
};

const realTimeout = globalThis.setTimeout;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fake(answer: (sent: Sent, init: RequestInit, index: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const record = {
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      at: Date.now(),
    };
    sent.push(record);
    return answer(record, init, sent.length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

function respond(
  answer: { status?: number; headers?: Record<string, string>; body?: unknown; failure?: string },
  init: RequestInit,
) {
  if (answer.failure === "connection") throw new TypeError("connection refused");
  if (answer.failure === "timeout") {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }
  const status = answer.status ?? 200;
  const empty = status === 204 || status === 304 || answer.body === undefined;
  return new Response(empty ? null : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), {
    status,
    headers: answer.headers ?? {},
  });
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let done = false;
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  void result.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.runAllTimersAsync();
    await new Promise((resolve) => realTimeout(resolve, 1));
  }
  return result;
}

function expectError(error: unknown, outcome: Record<string, unknown>) {
  if (outcome.kind === "ArgumentError") {
    expect(error).toBeInstanceOf(Error);
    expect(["TypeError", "RangeError"]).toContain((error as Error).name);
    expect((error as Error).message).toBe(outcome.message);
    return;
  }
  const kinds: Record<string, unknown> = { ApiError, TokenError, SnapshotError, TimeoutError };
  expect(error).toBeInstanceOf(kinds[outcome.kind as string] as typeof Error);
  for (const field of ["status", "code", "message"]) {
    if (outcome[field] !== undefined)
      expect((error as Record<string, unknown>)[field]).toEqual(rawEnum(outcome[field]));
  }
}

function rawEnum(value: unknown): unknown {
  return value && typeof value === "object" && "unknown" in value ? (value as { unknown: string }).unknown : value;
}

function decodedValue(value: unknown): unknown {
  if (value === true) return { kind: "on" };
  if (value === "unlimited") return { kind: "unlimited" };
  return { kind: "amount", amount: value };
}

function decodedInstant(value: unknown): unknown {
  return value instanceof Date ? { instant: value.toISOString(), epochMillis: value.getTime() } : value;
}

function utf16(units: number[]): string {
  return String.fromCharCode(...units);
}

describe("the conformance manifest", () => {
  it.each(manifest.files)("matches $path", ({ path, cases, sha256 }) => {
    const bytes = readFileSync(new URL(path, folder));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    expect((JSON.parse(bytes.toString("utf8")) as { cases: unknown[] }).cases).toHaveLength(cases);
  });
});

describe("conformance: cache-keys.json", () => {
  conformance("cache-keys.json", async (c) => {
    const built = c.built as { baseUrl: string; route: string; params: Record<string, string> };
    const asked: string[] = [];
    const cache = new (class extends MemoryCache {
      override get(key: string) {
        asked.push(key);
        return undefined;
      }
    })();
    const { fetch, sent } = fake(() => Response.json(BODY, { headers: { etag: '"1"' } }));
    const common = {
      baseUrl: built.baseUrl,
      fetch,
      cache,
    };
    const asOf = c.asOf ? { asOf: (c.asOfInput ?? c.asOf) as string } : {};
    const visitor = (c.visitor as string | null) ?? undefined;
    let customer: ServerCustomer | EntitlerClient<"token">["me"];
    let server: EntitlerServer | undefined;
    if (c.principalKind === "key") {
      server = new EntitlerServer({ key: c.credential as string, ...common });
      customer = server.customer(built.params.id ?? "unused");
    } else {
      customer = new EntitlerClient({ token: c.credential as string, ...common, ...(visitor ? { visitor } : {}) }).me;
    }
    const pricingOptions = c.principalKind === "key" && visitor ? { visitor } : {};
    const reads: Record<string, () => Promise<unknown>> = {
      "/customers/{id}/entitlements/{feature}": () => customer.check(built.params.feature as string, asOf),
      "/customers/{id}/entitlements": () => customer.entitlements(asOf),
      "/customers/{id}/plans": () => customer.plans(asOf),
      "/customers/{id}/pricing": () => customer.pricing(pricingOptions),
      "/pricing": () => (server as EntitlerServer).pricing(pricingOptions),
      "/pricing/features": () => (server as EntitlerServer).features(),
    };
    await (reads[built.route] as () => Promise<unknown>)().catch(() => undefined);
    const outcome = c.outcome as { cacheKey: string; requestHeaders: Record<string, string | null> };
    expect(asked).toEqual([outcome.cacheKey]);
    expect(sent[0]?.url).toBe(c.url);
    for (const [name, value] of Object.entries(outcome.requestHeaders)) {
      expect(sent[0]?.headers.get(name)).toBe(value);
    }
  });
});

describe("conformance: path-encoding.json", () => {
  const ids = (c: Case) => (c.idUtf16 ? utf16(c.idUtf16 as number[]) : (c.id as string));
  conformance("path-encoding.json", async (c) => {
    const { fetch, sent } = fake(() => Response.json(BODY));
    const server = new EntitlerServer({
      key: "ent_test_conformance_server_key",
      fetch,
      cache: false,
      maxRetries: 0,
      ...(c.kind === "baseUrl" && c.baseUrl ? { baseUrl: c.baseUrl as string } : {}),
    });
    const request = c.request as { method: string; route: string; params: Record<string, string> };
    const params = { ...request.params };
    if (c.kind === "segment") params[c.parameter === "customer" ? "id" : (c.parameter as string)] = ids(c);
    const call = async () => {
      if (c.kind === "query") {
        const q = c.valueUtf16 ? utf16(c.valueUtf16 as number[]) : (c.value as string);
        for await (const page of server.customers.list({ q }).pages()) return page;
        return undefined;
      }
      const customer = server.customer(params.id as string);
      if (request.route.endsWith("{feature}")) return customer.check(params.feature as string);
      if (request.route.endsWith("{plan}")) return customer.cancel({ addOn: params.plan as string });
      if (request.route.endsWith("{holdId}")) return customer.releaseUsage(params.holdId as string);
      if (request.route.endsWith("{grantId}")) return customer.revokeGrant(params.grantId as string);
      if (request.route.endsWith("{usageId}")) return customer.cancelUsage(params.usageId as string);
      throw new Error(`No method for ${request.route}`);
    };
    const result = await call().then(
      () => undefined,
      (error: unknown) => error,
    );
    if (c.outcome.kind) {
      expectError(result, c.outcome);
      expect(sent).toHaveLength(0);
    } else {
      expect(sent[0]?.url).toBe(c.outcome.url);
    }
  });
});

describe("conformance: idempotency-keys.json", () => {
  const aiCredits = defineFeature("ai_credits", "metered");
  conformance("idempotency-keys.json", async (c) => {
    const { fetch, sent } = fake((record) => {
      if (record.url.endsWith("/usage/holds")) {
        return Response.json({
          ...BODY,
          feature: "ai_credits",
          outcome: "held",
          holdId: "h1",
          amount: 5,
          expiresAt: "2999-01-01T00:00:00.000Z",
        });
      }
      if (record.url.endsWith("/usage/events"))
        return Response.json({ results: [], recorded: 0, duplicates: 0, errors: 0 });
      return Response.json({ ...BODY, outcome: "settled" });
    });
    const server = new EntitlerServer({ key: "ent_test_conformance_server_key", fetch, cache: false });
    const customer = server.customer("user_42");
    const key = (c.key as string | null) ?? undefined;
    const run = async () => {
      if (c.method === "write") return customer.recordUsage(aiCredits, 1, { idempotencyKey: key as string });
      if (c.method === "withHold")
        return customer.withHold(aiCredits, 5, ({ hold }) => hold.use(7), { idempotencyKey: key as string });
      return server.recordUsageBatch([
        { customer: "user_42", feature: aiCredits, amount: 1, idempotencyKey: key as string },
      ]);
    };
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    if (c.outcome.kind) {
      expectError(error, c.outcome);
      expect(sent).toHaveLength(0);
      return;
    }
    expect(error).toBeUndefined();
    if (c.method === "write") expect(sent[0]?.headers.get("idempotency-key")).toBe(key);
    if (c.method === "withHold") {
      expect(sent[0]?.headers.get("idempotency-key")).toBe(key);
      expect(sent.at(-1)?.headers.get("idempotency-key")).toBe(c.outcome.excessKey);
    }
  });
});

describe("conformance: retry-timing.json", () => {
  function clock(now: string) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date(now) });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  }

  function waits(sent: Sent[]): number[] {
    return sent.slice(1).map((record, index) => (record.at - (sent[index] as Sent).at) / 1000);
  }

  function expectWaits(actual: number[], expected: { minSeconds: number; maxSeconds: number }[]) {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((wait, index) => {
      expect(wait).toBeGreaterThanOrEqual((expected[index] as { minSeconds: number }).minSeconds);
      expect(wait).toBeLessThanOrEqual((expected[index] as { maxSeconds: number }).maxSeconds);
    });
  }

  conformance("retry-timing.json", async (c) => {
    clock((c.now as string | undefined) ?? "2026-07-01T09:30:00.000Z");
    if (c.kind === "retryAfter") {
      const headers: Record<string, string> = c.retryAfter === null ? {} : { "retry-after": c.retryAfter as string };
      const { fetch, sent } = fake((_record, init, index) =>
        respond(index === 0 ? { status: 503, headers } : { status: 200, body: BODY }, init),
      );
      const server = new EntitlerServer({
        key: "k",
        fetch,
        cache: false,
        maxRetryDelay: (c.maxRetryDelay as number) * 1000,
      });
      const result = await settle(server.customer("user_42").check("export_pdf"));
      if (c.outcome.action === "fail") {
        expect(result.error).toBeInstanceOf(ApiError);
        expect(sent).toHaveLength(1);
      } else if (c.outcome.action === "wait") {
        expect(waits(sent)).toEqual([c.outcome.seconds]);
      } else {
        expectWaits(waits(sent), [{ minSeconds: 0, maxSeconds: 0.5 }]);
      }
      return;
    }
    if (c.kind === "backoff") {
      const retry = c.retry as number;
      const { fetch, sent } = fake((_record, init, index) =>
        respond(index <= retry ? { status: 503 } : { status: 200, body: BODY }, init),
      );
      const server = new EntitlerServer({ key: "k", fetch, cache: false, maxRetries: retry + 1 });
      await settle(server.customer("user_42").check("export_pdf"));
      const last = waits(sent).at(-1) as number;
      expect(last).toBeGreaterThanOrEqual(c.outcome.minSeconds as number);
      expect(last).toBeLessThanOrEqual(c.outcome.maxSeconds as number);
      return;
    }
    if (c.kind === "limits") {
      const maxRetries = c.maxRetries as number;
      const plain = fake((_record, init) => respond({ status: 503 }, init));
      await settle(
        new EntitlerServer({ key: "k", fetch: plain.fetch, cache: false, maxRetries }).customer("u").check("f"),
      );
      expect(plain.sent).toHaveLength(c.outcome.maxAttemptsWithoutUnauthorised as number);
      let n = 0;
      const provider = () => tokenFor(`limits-${++n}`);
      const withRefresh = fake((_record, init, index) =>
        respond(index === 0 ? { status: 401 } : { status: 503 }, init),
      );
      await settle(
        new EntitlerClient({ token: provider, fetch: withRefresh.fetch, cache: false, maxRetries }).me.check("f"),
      );
      expect(withRefresh.sent).toHaveLength(c.outcome.maxAttempts as number);
      return;
    }
    const answers = c.answers as {
      status?: number;
      headers?: Record<string, string>;
      body?: unknown;
      failure?: string;
    }[];
    const { fetch, sent } = fake((_record, init, index) => respond(answers[index] ?? { status: 599 }, init));
    const credential = c.credential as { kind: string; key?: string; token?: string; tokens?: string[] };
    const options = {
      fetch,
      cache: false as const,
      maxRetries: c.maxRetries as number,
      maxRetryDelay: (c.maxRetryDelay as number) * 1000,
      timeout: 5,
    };
    let providerCalls = 0;
    const request = c.request as { method: string; path: string };
    let call: Promise<unknown>;
    if (credential.kind === "key") {
      const customer = new EntitlerServer({ key: credential.key as string, ...options }).customer("user_42");
      call =
        request.method === "GET"
          ? customer.check("export_pdf")
          : customer.recordUsage(defineFeature("ai_credits", "metered"), 1, {
              idempotencyKey: "conformance-write-key",
            });
    } else {
      const token =
        credential.kind === "customerToken"
          ? (credential.token as string)
          : () => (credential.tokens as string[])[providerCalls++] as string;
      call = new EntitlerClient({ token, ...options }).me.check("export_pdf");
    }
    const result = await settle(call);
    expect(sent).toHaveLength(c.outcome.attempts as number);
    if (c.outcome.providerCalls !== undefined) expect(providerCalls).toBe(c.outcome.providerCalls);
    expectWaits(waits(sent), c.outcome.waits as { minSeconds: number; maxSeconds: number }[]);
    const expected = c.outcome.result as Record<string, unknown>;
    if (expected.kind) expectError(result.error, expected);
    else expect(result.error).toBeUndefined();
    if (c.outcome.sameIdempotencyKeyOnEveryAttempt) {
      expect(new Set(sent.map((record) => record.headers.get("idempotency-key"))).size).toBe(1);
    }
    if (c.outcome.errorCarriesIdempotencyKey) {
      expect((result.error as ApiError).idempotencyKey).toBe(sent[0]?.headers.get("idempotency-key"));
    }
  });
});

function tokenFor(signature: string, expiresIn = 3600): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: "none" })}.${part({ sub: "u", iat: now, exp: now + expiresIn })}.${signature}`;
}

describe("conformance: token-refresh.json", () => {
  conformance("token-refresh.json", async (c) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(c.receivedAt as string) });
    let calls = 0;
    const provider = () => {
      calls += 1;
      return c.token as string;
    };
    const { fetch, sent } = fake(() => Response.json(BODY));
    const client = new EntitlerClient({ token: provider, fetch, cache: false });
    const first = await client.me.check("export_pdf").then(
      () => undefined,
      (e: unknown) => e,
    );
    if (c.outcome.kind) {
      expectError(first, c.outcome);
      expect(sent).toHaveLength(0);
      return;
    }
    expect(first).toBeUndefined();
    expect(sent[0]?.headers.get("authorization")).toBe(
      (c.outcome.requestHeaders as { Authorization: string }).Authorization,
    );
    vi.setSystemTime(new Date(c.now as string));
    await client.me.check("export_pdf");
    expect(calls).toBe(c.outcome.asksProvider ? 2 : 1);
  });
});

describe("conformance: values.json", () => {
  conformance("values.json", async (c) => {
    const { fetch } = fake(
      () => new Response(JSON.stringify(c.answer), { status: 200, headers: c.headers as Record<string, string> }),
    );
    const server = new EntitlerServer({ key: "ent_test_conformance_server_key", fetch, cache: false, maxRetries: 0 });
    const feature = (c.request as { path: string }).path.split("/").at(-1) as string;
    const result = await server
      .customer("user_42")
      .check(feature)
      .then(
        (check) => ({ check: check as unknown as Record<string, unknown> }),
        (error: unknown) => ({ error }),
      );
    if (c.kind === "value") {
      const expected = c.outcome.answer as Record<string, unknown>;
      if (expected.kind) return expectError((result as { error: unknown }).error, expected);
      const check = (result as { check: Record<string, unknown> }).check;
      expect(decodedValue(check.value)).toEqual(expected.value);
      expect(check.entitled).toBe(expected.entitled);
      return;
    }
    if (c.kind === "instant") {
      if (c.outcome.kind) return expectError((result as { error: unknown }).error, c.outcome);
      const check = (result as { check: Record<string, unknown> }).check;
      expect(decodedInstant(check[c.field as string])).toEqual(c.outcome.instant);
      return;
    }
    const check = (result as { check: Record<string, unknown> }).check;
    const { absent = [], ...fields } = c.outcome as Record<string, unknown> & { absent?: string[] };
    for (const [name, expected] of Object.entries(fields)) {
      const actual = check[name];
      if (name === "value" || name === "remaining") expect(decodedValue(actual)).toEqual(expected);
      else if (name === "asOf" || name === "resetsAt") expect(decodedInstant(actual)).toEqual(expected);
      else if (name === "environment" || name === "experiment" || name === "track") {
        const known =
          expected && Object.fromEntries(Object.entries(expected as object).map(([k, v]) => [k, rawEnum(v)]));
        if (known) expect(actual).toMatchObject(known);
        else expect(actual).toBe(known);
      } else expect(actual).toEqual(rawEnum(expected));
    }
    for (const name of absent) expect(check[name]).toBeUndefined();
  });
});

describe("conformance: errors.json", () => {
  conformance("errors.json", async (c) => {
    if (c.receivedAt) vi.useFakeTimers({ toFake: ["Date"], now: new Date(c.receivedAt as string) });
    const { fetch } = fake(
      () =>
        new Response([204, 304].includes(c.status as number) || c.body === "" ? null : (c.body as string), {
          status: c.status as number,
          headers: c.headers as Record<string, string>,
        }),
    );
    const server = new EntitlerServer({ key: "ent_test_conformance_server_key", fetch, cache: false, maxRetries: 0 });
    const call = c.call as Record<string, string | number>;
    const customer = server.customer(call.customer as string);
    const run = () => {
      if (call.method === "check") return customer.check(call.feature as string);
      if (call.method === "recordUsage") {
        return customer.recordUsage(defineFeature(call.feature as string, "metered"), call.amount as number, {
          idempotencyKey: call.idempotencyKey as string,
        });
      }
      return customer.subscribe(call.plan as string, {
        period: call.period as string,
        idempotencyKey: call.idempotencyKey as string,
      });
    };
    const error = (await run().then(
      () => undefined,
      (e: unknown) => e,
    )) as ApiError;
    const o = c.outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(o.status);
    expect(error.code).toBe(rawEnum(o.code));
    expect(error.message).toBe(o.message);
    expect(error.requestId ?? null).toBe(o.requestId);
    expect(error.retryAfter === undefined ? null : error.retryAfter / 1000).toBe(o.retryAfterSeconds);
    expect(error.idempotencyKey ?? null).toBe(o.idempotencyKey);
    expect(error.payment ?? null).toEqual(o.payment);
    expect(error.listingGaps.map((gap) => ({ ...gap, kind: gap.kind }))).toEqual(
      (o.listingGaps as Record<string, unknown>[]).map((gap) => ({ ...gap, kind: rawEnum(gap.kind) })),
    );
    expect(error.listingProblems).toEqual(
      (o.listingProblems as Record<string, unknown>[]).map((problem) => ({
        ...problem,
        problem: rawEnum(problem.problem),
      })),
    );
  });
});

describe("conformance: snapshots.json", () => {
  function item(entitlement: Record<string, unknown>) {
    const out: Record<string, unknown> = {
      key: entitlement.key,
      type: entitlement.type,
      value: decodedValue(entitlement.value),
      entitled: entitlement.entitled,
    };
    const absent: string[] = [];
    for (const name of ["used", "remaining", "held", "resetsAt"]) {
      if (entitlement[name] === undefined) absent.push(name);
      else if (name === "remaining") out[name] = decodedValue(entitlement[name]);
      else if (name === "resetsAt") out[name] = decodedInstant(entitlement[name]);
      else out[name] = entitlement[name];
    }
    if (absent.length) out.absent = absent;
    return out;
  }

  function normalise(expected: Record<string, unknown>): Record<string, unknown> {
    const items = (expected.items as Record<string, unknown>[]).map((each) => ({ ...each, type: rawEnum(each.type) }));
    const get = Object.fromEntries(
      Object.entries(expected.get as Record<string, Record<string, unknown> | null>).map(([key, value]) => [
        key,
        value && { ...value, type: rawEnum(value.type) },
      ]),
    );
    return { ...expected, items, get };
  }

  conformance("snapshots.json", async (c) => {
    const expected = c.expected as Record<string, unknown>;
    const result = await verifySnapshot(c.token as string, {
      ...(expected as unknown as Parameters<typeof verifySnapshot>[1]),
      now: new Date(expected.now as string),
    }).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error }),
    );
    if (!("snapshot" in c.outcome)) {
      expectError((result as { error: unknown }).error, c.outcome);
      if (c.outcome.code) expect((result as { error: SnapshotError }).error.code).toBe(c.outcome.code);
      return;
    }
    expect((result as { error?: unknown }).error).toBeUndefined();
    const snapshot = (result as { snapshot: Awaited<ReturnType<typeof verifySnapshot>> }).snapshot;
    const want = c.outcome.snapshot as Record<string, unknown>;
    const wantEntitlements = normalise(want.entitlements as Record<string, unknown>);
    expect({
      customer: snapshot.customer,
      environment: snapshot.environment,
      track: snapshot.track,
      release: snapshot.release,
      change: snapshot.change,
      testers: snapshot.testers,
      expiresAt: decodedInstant(snapshot.expiresAt),
    }).toEqual({ ...want, entitlements: undefined });
    const keys = Object.keys(wantEntitlements.has as object);
    expect({
      asOf: decodedInstant(snapshot.entitlements.asOf),
      experiment: snapshot.entitlements.experiment,
      items: snapshot.entitlements.entitlements.map((each) => item(each as unknown as Record<string, unknown>)),
      has: Object.fromEntries(keys.map((key) => [key, snapshot.entitlements.has(key)])),
      get: Object.fromEntries(
        Object.keys(wantEntitlements.get as object).map((key) => {
          const found = snapshot.entitlements.get(key);
          return [key, found ? item(found as unknown as Record<string, unknown>) : null];
        }),
      ),
    }).toEqual(wantEntitlements);
  });
});
