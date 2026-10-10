import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConnectionError,
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  type Hold,
  SnapshotError,
  TimeoutError,
  TokenError,
  verifySnapshot,
} from "../../src/index.js";
import { observeCacheKeys } from "../../src/transport.js";

type Case = Record<string, unknown> & { name: string; outcome: Record<string, unknown> };
type Sent = { url: string; method: string; headers: Headers; body: string | undefined; at: number };

const folder = new URL("../fixtures/conformance/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")) as {
  files: { path: string; cases: number; sha256: string }[];
};

function load(path: string): Case[] {
  return (JSON.parse(readFileSync(new URL(path, folder), "utf8")) as { cases: Case[] }).cases;
}

const NOT_IN_TYPESCRIPT = new Set(["an in-app read can be given asOf"]);

function conformance(path: string, test: (c: Case) => unknown) {
  for (const c of load(path)) {
    const condition = c.appliesWhere as string | undefined;
    if (condition && NOT_IN_TYPESCRIPT.has(condition)) it.skip(`${c.name} (applies only where ${condition})`, () => {});
    else
      it(c.name, async () => {
        await test(c);
      });
  }
}

const SERVER_KEY = "ent_test_conformance_server_key";
const aiCredits = defineFeature("ai_credits", "metered");

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
  observeCacheKeys(undefined);
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
      body: typeof init.body === "string" ? init.body : undefined,
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
  if (answer.failure === "cut-off") {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"customer":"user_42","asOf":'));
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }
  const status = answer.status ?? 200;
  const empty = status === 204 || status === 304 || answer.body === undefined;
  return new Response(empty ? null : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), {
    status,
    headers: answer.headers ?? {},
  });
}

function text(status: number, headers: Record<string, string>, body: string): Response {
  return new Response([204, 304].includes(status) || body === "" ? null : body, { status, headers });
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

async function outcomeOf(call: () => unknown): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await call() };
  } catch (error) {
    return { error };
  }
}

function expectError(error: unknown, outcome: Record<string, unknown>) {
  if (outcome.kind === "ArgumentError") {
    expect(error).toBeInstanceOf(Error);
    expect(["TypeError", "RangeError"]).toContain((error as Error).name);
    expect((error as Error).message).toBe(outcome.message);
    return;
  }
  if (outcome.kind === "ClosedError") {
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("InvalidStateError");
    expect((error as DOMException).message).toBe(outcome.message);
    return;
  }
  const kinds: Record<string, unknown> = { ApiError, ConnectionError, TokenError, SnapshotError, TimeoutError };
  expect(error).toBeInstanceOf(kinds[outcome.kind as string] as typeof Error);
  for (const field of ["status", "code", "message"]) {
    if (outcome[field] !== undefined) expect((error as Record<string, unknown>)[field]).toEqual(raw(outcome[field]));
  }
}

function expectApiError(error: unknown, outcome: Record<string, unknown>) {
  expect(error).toBeInstanceOf(ApiError);
  const e = error as ApiError;
  expect({
    kind: "ApiError",
    status: e.status,
    code: e.code,
    message: e.message,
    requestId: e.requestId ?? null,
    retryAfterSeconds: e.retryAfter === undefined ? null : e.retryAfter / 1000,
    idempotencyKey: e.idempotencyKey ?? null,
    payment: e.payment ?? null,
  }).toEqual(raw(outcome));
}

function raw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(raw);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]?.[0] === "unknown") return entries[0][1];
    return Object.fromEntries(entries.map(([key, each]) => [key, raw(each)]));
  }
  return value;
}

function decodedValue(value: unknown): unknown {
  if (value === true) return { kind: "on" };
  if (value === "unlimited") return { kind: "unlimited" };
  return { kind: "amount", amount: value };
}

function decodedInstant(value: unknown): unknown {
  return value instanceof Date ? { instant: value.toISOString(), epochMillis: value.getTime() } : value;
}

function isInstant(value: unknown): boolean {
  return !!value && typeof value === "object" && "epochMillis" in value;
}

function isValueForm(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "kind" in value &&
    ["on", "amount", "unlimited"].includes(String((value as { kind: unknown }).kind))
  );
}

function view(actual: unknown, expected: unknown): unknown {
  if (expected === null) return actual ?? null;
  if (isInstant(expected)) return decodedInstant(actual);
  if (isValueForm(expected)) return decodedValue(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) ? actual.map((each, index) => view(each, expected[index])) : actual;
  }
  if (expected && typeof expected === "object" && !("unknown" in expected)) {
    if (!actual || typeof actual !== "object") return actual;
    const source = actual as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(expected).map(([key, each]) =>
        key === "absent"
          ? [key, (each as string[]).filter((name) => source[name] === undefined)]
          : [key, view(source[key], each)],
      ),
    );
  }
  return actual;
}

function expectView(actual: unknown, expected: unknown) {
  expect(view(actual, expected)).toEqual(raw(expected));
}

function utf16(units: number[]): string {
  return String.fromCharCode(...units);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    const { fetch, sent } = fake(() =>
      Response.json(
        built.route === "/pricing/features"
          ? { ...BODY, features: [] }
          : built.route.endsWith("/plans")
            ? { ...BODY, held: [], options: [] }
            : built.route.endsWith("/entitlements")
              ? { ...BODY, entitlements: [] }
              : BODY,
        { headers: { etag: '"1"' } },
      ),
    );
    const store = { get: (key: string) => void asked.push(key), set: () => {} };
    observeCacheKeys((key) => asked.push(key));
    const visitor = (c.visitor as string | null) ?? undefined;
    const clientVisitor = (c.clientVisitor as string | undefined) ?? visitor;
    const inApp = { baseUrl: built.baseUrl, fetch, ...(clientVisitor ? { visitor: clientVisitor } : {}) };
    const callVisitor = c.clientVisitor ? { visitor } : {};
    const asOf = c.asOf ? { asOf: (c.asOfInput ?? c.asOf) as string } : {};
    let read: () => Promise<unknown>;
    let close: () => void;
    const credential = (c.credential as string | undefined)?.trim() ?? "";
    if (c.principalKind === "key" && !credential.startsWith("ent_pk_")) {
      observeCacheKeys(undefined);
      const server = new EntitlerServer({ key: c.credential as string, baseUrl: built.baseUrl, fetch, cache: store });
      const customer = server.customer(built.params.id ?? "unused");
      const given = visitor ? { visitor } : {};
      const reads: Record<string, () => Promise<unknown>> = {
        "/customers/{id}/entitlements/{feature}": () => customer.check(built.params.feature as string, asOf),
        "/customers/{id}/entitlements": () => customer.entitlements(asOf),
        "/customers/{id}/plans": () => customer.plans(asOf),
        "/customers/{id}/pricing": () => customer.pricing(given),
        "/pricing": () => server.pricing(given),
        "/pricing/features": () => server.features(),
      };
      read = reads[built.route] as () => Promise<unknown>;
      close = () => server.close();
    } else if (c.principalKind === "key") {
      const client = new EntitlerClient({ key: c.credential as string, ...inApp });
      read = () => client.pricing(callVisitor);
      close = () => client.close();
    } else {
      const client =
        c.principalKind === "customer-token"
          ? new EntitlerClient({ token: c.credential as string, ...inApp })
          : new EntitlerClient({ key: c.key as string, identityToken: c.identityToken as string, ...inApp });
      const reads: Record<string, () => Promise<unknown>> = {
        "/customers/{id}/entitlements/{feature}": () => client.me.check(built.params.feature as string),
        "/customers/{id}/entitlements": () => client.me.entitlements(),
        "/customers/{id}/plans": () => client.me.plans(),
        "/customers/{id}/pricing": () => client.me.pricing(callVisitor),
      };
      read = reads[built.route] as () => Promise<unknown>;
      close = () => client.close();
    }
    const result = await outcomeOf(read);
    close();
    expect(result.error).toBeUndefined();
    const outcome = c.outcome as {
      cacheKey: string;
      serialised: string;
      requestHeaders: Record<string, string | null>;
    };
    expect(createHash("sha256").update(outcome.serialised).digest("hex")).toBe(outcome.cacheKey);
    expect(asked).toEqual([outcome.cacheKey]);
    expect(sent[0]?.url).toBe(c.url);
    for (const [name, value] of Object.entries(outcome.requestHeaders)) {
      expect(sent[0]?.headers.get(name)).toBe(value);
    }
  });
});

describe("conformance: path-encoding.json", () => {
  conformance("path-encoding.json", async (c) => {
    const { fetch, sent } = fake(() => Response.json({ ...BODY, items: [], next: null, used: 0, limit: null }));
    const server = new EntitlerServer({
      key: SERVER_KEY,
      fetch,
      cache: false,
      maxRetries: 0,
      ...(c.kind === "baseUrl" && c.baseUrl ? { baseUrl: c.baseUrl as string } : {}),
    });
    const request = (c.request ?? {}) as {
      method: string;
      route: string;
      params: Record<string, string>;
      options?: Record<string, unknown>;
    };
    const params = { ...request.params };
    const id = c.idUtf16 ? utf16(c.idUtf16 as number[]) : (c.id as string);
    if (c.kind === "segment") params[c.parameter === "customer" ? "id" : (c.parameter as string)] = id;
    const options = request.options ?? {};
    const call = async () => {
      if (c.kind === "arguments") {
        const args = c.call as { method: string; customer: string; options: Record<string, string> };
        const customer = server.customer(args.customer);
        return args.method === "cancel" ? customer.cancel(args.options) : customer.undoPendingChange(args.options);
      }
      if (c.kind === "query") {
        const value = c.valueUtf16 ? utf16(c.valueUtf16 as number[]) : (c.value as string);
        if (request.route === "/customers") {
          for await (const page of server.customers.list({ [c.parameter as string]: value }).pages()) return page;
          return undefined;
        }
        const customer = server.customer(params.id as string);
        return request.route.endsWith("/pending")
          ? customer.undoPendingChange({ product: value })
          : customer.cancel({ product: value });
      }
      const customer = server.customer(params.id as string);
      const routes: Record<string, () => Promise<unknown>> = {
        "GET /customers/{id}/entitlements/{feature}": () => customer.check(params.feature as string),
        "DELETE /customers/{id}?erase=true": () => customer.erase(),
        "DELETE /customers/{id}/subscription/add-ons/{addOn}": () => customer.cancel({ addOn: params.addOn as string }),
        "DELETE /customers/{id}/subscription/add-ons/{addOn}/pending": () =>
          customer.undoPendingChange({ addOn: params.addOn as string }),
        "PUT /customers/{id}/add-ons/{addOn}": () =>
          customer.setAddOn(params.addOn as string, { quantity: options.quantity as number }),
        "POST /customers/{id}/meters/{feature}/adjustments": () =>
          customer.adjustMeter(defineFeature(params.feature as string, "metered"), {
            by: options.by as number,
            idempotencyKey: options.idempotencyKey as string,
          }),
        "POST /customers/{id}/usage/holds/{holdId}/settle": () =>
          customer.settleUsage(params.holdId as string, options.amount as number),
        "DELETE /customers/{id}/usage/holds/{holdId}": () => customer.releaseUsage(params.holdId as string),
        "DELETE /customers/{id}/grants/{grantId}": () => customer.revokeGrant(params.grantId as string),
        "DELETE /customers/{id}/usage/{usageId}": () => customer.cancelUsage(params.usageId as string),
      };
      const route = routes[`${request.method} ${request.route}`];
      if (!route) throw new Error(`No method for ${request.method} ${request.route}`);
      return route();
    };
    const result = await outcomeOf(call);
    server.close();
    if (c.outcome.kind) {
      expectError(result.error, c.outcome);
      expect(sent).toHaveLength(0);
    } else {
      expect(sent[0]?.url).toBe(c.outcome.url);
    }
  });
});

describe("conformance: idempotency-keys.json", () => {
  function answer(record: Sent): Response {
    if (record.url.endsWith("/usage/holds")) {
      return Response.json({
        ...BODY,
        feature: "ai_credits",
        type: "metered",
        value: 100,
        used: 0,
        held: 1,
        remaining: 99,
        resetsAt: null,
        outcome: "held",
        refusal: null,
        id: null,
        holdId: "hold_conformance_1",
        mode: "gate",
        amount: 1,
        meterChange: 0,
        overBy: 0,
        late: false,
        occurredAt: null,
        expiresAt: "2999-01-01T00:00:00.000Z",
        reportedAs: "api",
      });
    }
    const usage = {
      ...BODY,
      feature: "ai_credits",
      type: "metered",
      value: 100,
      used: 1,
      held: 0,
      remaining: 99,
      resetsAt: null,
      refusal: null,
      id: "use_conformance_1",
      holdId: null,
      mode: "gate",
      amount: 1,
      meterChange: 1,
      overBy: 0,
      late: false,
      occurredAt: null,
      expiresAt: null,
      reportedAs: "api",
    };
    if (record.url.endsWith("/settle")) return Response.json({ ...usage, outcome: "settled" });
    if (record.url.includes("/usage") || record.url.includes("/meters/")) {
      if (record.url.endsWith("/usage/events")) {
        const events = (JSON.parse(record.body as string) as { events: unknown[] }).events;
        return Response.json({
          results: events.map((_, index) => ({
            index,
            outcome: "recorded",
            id: `use_${index}`,
            late: false,
            error: null,
          })),
          recorded: events.length,
          duplicates: 0,
          errors: 0,
        });
      }
      return Response.json({ ...usage, outcome: record.url.includes("/meters/") ? "adjusted" : "recorded" });
    }
    if (record.url.endsWith("/tokens")) {
      return Response.json({
        token: "a.b.c",
        customer: "user_42",
        scopes: ["entitlements:read"],
        expiresAt: BODY.asOf,
      });
    }
    if (record.url.endsWith("/snapshots")) return Response.json({ token: "a.b.c", expiresAt: BODY.asOf, keyId: "k" });
    if (record.url.endsWith("/billing-portal"))
      return Response.json({ provider: "stripe", url: "https://billing.example" });
    if (record.url.endsWith("/billing/sync")) return Response.json({ changed: false });
    return Response.json({
      product: null,
      plan: null,
      quantity: null,
      effective: "now",
      at: BODY.asOf,
      until: null,
      changed: false,
    });
  }

  function events(c: Case): unknown[] {
    if (c.events) return c.events as unknown[];
    const pattern = c.eventPattern as {
      count: number;
      customerPrefix: string;
      customers: number;
      feature: string;
      keyPrefix: string;
    };
    const list: unknown[] = Array.from({ length: pattern.count }, (_, i) => ({
      customer: `${pattern.customerPrefix}${i % pattern.customers}`,
      feature: pattern.feature,
      amount: i + 1,
      idempotencyKey: `${pattern.keyPrefix}${i}`,
    }));
    for (const { index, event } of (c.overrides ?? []) as { index: number; event: unknown }[]) list[index] = event;
    return list;
  }

  conformance("idempotency-keys.json", async (c) => {
    const { fetch, sent } = fake((record) => answer(record));
    const server = new EntitlerServer({ key: SERVER_KEY, fetch, cache: false, maxRetries: 0 });
    const customer = server.customer("user_42");
    const key = (c.key as string | null) ?? undefined;
    const keyed = (key === undefined ? {} : { idempotencyKey: key }) as { idempotencyKey: string };
    if (c.method === "recordUsageBatch") {
      const input = events(c) as Parameters<EntitlerServer["recordUsageBatch"]>[0];
      const options = c.register === null || c.register === undefined ? undefined : { register: c.register as boolean };
      const calls = (c.calls as number | undefined) ?? 1;
      let last: Awaited<ReturnType<EntitlerServer["recordUsageBatch"]>> | undefined;
      for (let i = 0; i < calls; i += 1) last = await server.recordUsageBatch(input, options);
      server.close();
      const outcome = c.outcome as {
        refused: { index: number; code: string; message: string }[];
        requests: { events: number; serialised: string; idempotencyKey: string }[];
      };
      const refused = (last?.results ?? [])
        .filter((result) => result.outcome === "error")
        .map((result) => ({ index: result.index, code: result.error?.code, message: result.error?.message }));
      expect(refused).toEqual(outcome.refused);
      expect(sent).toHaveLength(outcome.requests.length * calls);
      sent.forEach((record, index) => {
        const request = outcome.requests[index % outcome.requests.length] as (typeof outcome.requests)[number];
        const body = JSON.parse(record.body as string) as {
          register?: boolean;
          events: { customer: string; feature: string; amount: number; occurredAt?: string; idempotencyKey: string }[];
        };
        expect(body.events).toHaveLength(request.events);
        const rows = body.events.map((event) => [
          event.customer,
          event.feature,
          event.amount,
          event.occurredAt ?? null,
          event.idempotencyKey,
        ]);
        expect(JSON.stringify(["entitler-batch-v1", body.register === true, rows])).toBe(request.serialised);
        expect(createHash("sha256").update(request.serialised).digest("hex")).toBe(
          request.idempotencyKey.slice("batch:".length),
        );
        expect(record.headers.get("idempotency-key")).toBe(request.idempotencyKey);
      });
      return;
    }
    const calls: Record<string, () => Promise<unknown>> = {
      recordUsage: () => customer.recordUsage(aiCredits, 1, keyed),
      holdUsage: () => customer.holdUsage(aiCredits, 1, keyed),
      startHold: async () => {
        const hold: Hold = await customer.startHold(aiCredits, 1, keyed);
        hold.use(2);
        return hold.finish();
      },
      withHold: () => customer.withHold(aiCredits, 1, ({ hold }) => hold.use(2), keyed),
      adjustMeter: () => customer.adjustMeter(aiCredits, { by: 1, ...keyed }),
      cancel: () => customer.cancel(keyed),
      token: () => customer.token(),
      snapshot: () => customer.snapshot(),
      billingPortal: () => customer.billingPortal({ returnUrl: "https://app.example.com/billing" }),
      syncBilling: () => customer.syncBilling(),
    };
    const run = calls[c.method as string] as () => Promise<unknown>;
    const result = await outcomeOf(run);
    if (c.outcome.kind) {
      server.close();
      expectError(result.error, c.outcome);
      expect(sent).toHaveLength(0);
      return;
    }
    expect(result.error).toBeUndefined();
    const first = sent[0]?.headers.get("idempotency-key");
    if (key === undefined) {
      await run();
      const second = sent.at(-1)?.headers.get("idempotency-key");
      expect(first).toMatch(UUID_V4);
      expect(second).toMatch(UUID_V4);
      expect(second).not.toBe(first);
    } else {
      expect(first).toBe(key);
    }
    if (c.outcome.excessKey) expect(sent.at(-1)?.headers.get("idempotency-key")).toBe(c.outcome.excessKey);
    server.close();
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

  function tokenFor(signature: string): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    return `${part({ alg: "none" })}.${part({ sub: "u", iat: now, exp: now + 3600 })}.${signature}`;
  }

  conformance("retry-timing.json", async (c) => {
    clock((c.now as string | undefined) ?? "2026-07-01T09:30:00.000Z");
    if (c.kind === "retryAfter") {
      const headers: Record<string, string> = c.retryAfter === null ? {} : { "retry-after": c.retryAfter as string };
      const { fetch, sent } = fake((_record, init, index) =>
        respond(index === 0 ? { status: 503, headers } : { status: 200, body: BODY }, init),
      );
      const server = new EntitlerServer({
        key: SERVER_KEY,
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
      const server = new EntitlerServer({ key: SERVER_KEY, fetch, cache: false, maxRetries: retry + 1 });
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
        new EntitlerServer({ key: SERVER_KEY, fetch: plain.fetch, cache: false, maxRetries }).customer("u").check("f"),
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
    const request = c.request as {
      method: string;
      path: string;
      body?: { feature: string; amount: number };
      idempotencyKey?: string;
    };
    let call: Promise<unknown>;
    if (credential.kind === "key") {
      const customer = new EntitlerServer({ key: credential.key as string, ...options }).customer("user_42");
      call =
        request.method === "GET"
          ? customer.check("export_pdf")
          : customer.recordUsage(
              defineFeature(request.body?.feature ?? "ai_credits", "metered"),
              request.body?.amount ?? 1,
              {
                idempotencyKey: request.idempotencyKey ?? "conformance-write-key",
              },
            );
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

describe("conformance: token-refresh.json", () => {
  conformance("token-refresh.json", async (c) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(c.receivedAt as string) });
    let calls = 0;
    const provider = () => {
      calls += 1;
      return c.token as string;
    };
    const { fetch, sent } = fake(() => Response.json(BODY));
    const client = c.key
      ? new EntitlerClient({ key: c.key as string, identityToken: provider, fetch, cache: false })
      : new EntitlerClient({ token: provider, fetch, cache: false });
    const first = await outcomeOf(() => client.me.check("export_pdf"));
    if (c.outcome.kind) {
      expectError(first.error, c.outcome);
      expect(sent).toHaveLength(0);
      client.close();
      return;
    }
    expect(first.error).toBeUndefined();
    for (const [name, value] of Object.entries(c.outcome.requestHeaders as Record<string, string>)) {
      expect(sent[0]?.headers.get(name)).toBe(value);
    }
    for (let i = 0; i < ((c.close as number | undefined) ?? 0); i += 1) client.close();
    vi.setSystemTime(new Date(c.now as string));
    const later = await outcomeOf(() => client.me.check("export_pdf"));
    if (c.outcome.later) {
      expectError(later.error, c.outcome.later as Record<string, unknown>);
      expect(sent).toHaveLength(1);
    } else {
      expect(later.error).toBeUndefined();
    }
    expect(calls).toBe(c.outcome.asksProvider ? 2 : 1);
    client.close();
  });
});

describe("conformance: construction.json", () => {
  conformance("construction.json", (c) => {
    const given = c.credentials as Record<string, unknown>;
    const credentials = Object.fromEntries(
      Object.entries(given).map(([name, value]) => [name, typeof value === "object" ? () => "a.b.c" : value]),
    );
    const store = { get: () => undefined, set: () => {} };
    const options = { ...credentials, ...(c.cache === "customStore" ? { cache: store } : {}) };
    const built = (() => {
      try {
        return {
          client:
            c.client === "EntitlerServer" ? new EntitlerServer(options as never) : new EntitlerClient(options as never),
        };
      } catch (error) {
        return { error };
      }
    })();
    if (c.outcome.kind) return expectError(built.error, c.outcome);
    expect(built.error).toBeUndefined();
    const client = built.client as EntitlerServer;
    for (const form of [
      String(client),
      JSON.stringify(client),
      inspect(client),
      inspect(client, { showHidden: true }),
    ]) {
      for (const secret of c.outcome.stringFormOmits as string[]) expect(form).not.toContain(secret);
    }
    client.close();
  });
});

describe("conformance: values.json", () => {
  conformance("values.json", async (c) => {
    const { fetch } = fake(
      () => new Response(JSON.stringify(c.answer), { status: 200, headers: c.headers as Record<string, string> }),
    );
    const server = new EntitlerServer({ key: SERVER_KEY, fetch, cache: false, maxRetries: 0 });
    const feature = (c.request as { path: string }).path.split("/").at(-1) as string;
    const result = await outcomeOf(() => server.customer("user_42").check(feature));
    server.close();
    if (c.kind === "value") {
      const expected = c.outcome.answer as Record<string, unknown>;
      if (expected.kind) return expectError(result.error, expected);
      return expectView(result.value, expected);
    }
    if (c.kind === "instant") {
      if (c.outcome.kind) return expectError(result.error, c.outcome);
      expect(decodedInstant((result.value as Record<string, unknown>)[c.field as string])).toEqual(c.outcome.instant);
      return;
    }
    if (c.outcome.kind) return expectError(result.error, c.outcome);
    expect(result.error).toBeUndefined();
    expectView(result.value, c.outcome);
  });
});

describe("conformance: answers.json", () => {
  conformance("answers.json", async (c) => {
    const { fetch } = fake(() => text(c.status as number, c.headers as Record<string, string>, c.body as string));
    const server = new EntitlerServer({ key: SERVER_KEY, fetch, cache: false, maxRetries: 0 });
    const call = c.call as Record<string, unknown>;
    const customer = server.customer(call.customer as string);
    const pick = (...names: string[]) =>
      Object.fromEntries(names.filter((name) => call[name] !== undefined).map((name) => [name, call[name]]));
    const calls: Record<string, () => Promise<unknown>> = {
      check: () => customer.check(call.feature as string),
      plans: () => customer.plans(),
      recordUsage: () =>
        customer.recordUsage(defineFeature(call.feature as string, "metered"), call.amount as number, {
          idempotencyKey: call.idempotencyKey as string,
        }),
      subscribe: () => customer.subscribe(call.plan as string, pick("period", "returnUrl", "idempotencyKey")),
      cancel: () => customer.cancel(pick("addOn", "idempotencyKey")),
      undoPendingChange: () => customer.undoPendingChange(pick("idempotencyKey")),
      setPlan: () =>
        customer.setPlan(call.plan as string, pick("period", "until", "reason", "actor", "idempotencyKey")),
      setAddOn: () =>
        customer.setAddOn(call.addOn as string, { quantity: call.quantity as number, ...pick("idempotencyKey") }),
      grant: () => customer.grant(call.feature as string, pick("value", "days", "reason", "actor", "idempotencyKey")),
      revokeGrant: () => customer.revokeGrant(call.grantId as string, pick("idempotencyKey")),
      billingPortal: () => customer.billingPortal({ returnUrl: call.returnUrl as string }),
      syncBilling: () => customer.syncBilling(),
    };
    const result = await outcomeOf(calls[call.method as string] as () => Promise<unknown>);
    server.close();
    if (c.outcome.kind) return expectApiError(result.error, c.outcome);
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, unknown>;
    expectView(value.next === "unknown" ? { next: value.raw } : value, c.outcome);
  });
});

describe("conformance: errors.json", () => {
  conformance("errors.json", async (c) => {
    if (c.receivedAt) vi.useFakeTimers({ toFake: ["Date"], now: new Date(c.receivedAt as string) });
    const { fetch } = fake(() => text(c.status as number, c.headers as Record<string, string>, c.body as string));
    const call = c.call as Record<string, unknown>;
    const options = { fetch, cache: false as const, maxRetries: 0 };
    const server = new EntitlerServer({ key: SERVER_KEY, ...options });
    const run = (): Promise<unknown> => {
      if (call.method === "register") {
        const client = call.client as { key: string; identityToken: string };
        const app = new EntitlerClient({ key: client.key, identityToken: client.identityToken, ...options });
        return app.register({ idempotencyKey: call.idempotencyKey as string }).finally(() => app.close());
      }
      const customer = server.customer(call.customer as string);
      if (call.method === "check") {
        return customer.check(call.feature as string, call.asOf ? { asOf: call.asOf as string } : {});
      }
      if (call.method === "recordUsage") {
        return customer.recordUsage(defineFeature(call.feature as string, "metered"), call.amount as number, {
          idempotencyKey: call.idempotencyKey as string,
        });
      }
      if (call.method === "setPlan") {
        return call.sku
          ? customer.setPlan(
              { sku: call.sku as { connector: string; ids: Record<string, string> } },
              { until: call.until as string, idempotencyKey: call.idempotencyKey as string },
            )
          : customer.setPlan(call.plan as string, {
              period: call.period as string,
              idempotencyKey: call.idempotencyKey as string,
            });
      }
      return customer.subscribe(call.plan as string, {
        period: call.period as string,
        idempotencyKey: call.idempotencyKey as string,
      });
    };
    const result = await outcomeOf(run);
    server.close();
    expectApiError(result.error, c.outcome);
  });
});

describe("conformance: snapshots.json", () => {
  function item(entitlement: Record<string, unknown>) {
    const out: Record<string, unknown> = {
      key: entitlement.key,
      type: entitlement.type,
      value: decodedValue(entitlement.value),
      entitled: entitlement.entitled,
      upgrades: entitlement.upgrades ?? [],
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

  conformance("snapshots.json", async (c) => {
    const expected = c.expected as Record<string, unknown>;
    const result = await outcomeOf(() =>
      verifySnapshot(c.token as string, {
        ...(expected as unknown as Parameters<typeof verifySnapshot>[1]),
        now: new Date(expected.now as string),
      }),
    );
    if (!("snapshot" in c.outcome)) {
      expectError(result.error, c.outcome);
      if (c.outcome.code) expect((result.error as SnapshotError).code).toBe(c.outcome.code);
      return;
    }
    expect(result.error).toBeUndefined();
    const snapshot = result.value as Awaited<ReturnType<typeof verifySnapshot>>;
    const want = raw(c.outcome.snapshot) as Record<string, unknown>;
    const wantEntitlements = want.entitlements as Record<string, Record<string, unknown>>;
    const lookup = Object.keys(wantEntitlements).find((name) => !["asOf", "experiment", "items", "has"].includes(name));
    expect({
      customer: snapshot.customer,
      environment: snapshot.environment,
      track: snapshot.track,
      release: snapshot.release,
      change: snapshot.change,
      testers: snapshot.testers,
      expiresAt: decodedInstant(snapshot.expiresAt),
    }).toEqual({ ...want, entitlements: undefined });
    const actual: Record<string, unknown> = {
      asOf: decodedInstant(snapshot.entitlements.asOf),
      experiment: snapshot.entitlements.experiment,
      items: snapshot.entitlements.entitlements.map((each) => item(each as unknown as Record<string, unknown>)),
      has: Object.fromEntries(
        Object.keys(wantEntitlements.has as object).map((key) => [key, snapshot.entitlements.has(key)]),
      ),
    };
    if (lookup) {
      actual[lookup] = Object.fromEntries(
        Object.keys(wantEntitlements[lookup] as object).map((key) => {
          const found = snapshot.entitlements.get(key);
          return [key, found ? item(found as unknown as Record<string, unknown>) : null];
        }),
      );
    }
    expect(actual).toEqual(wantEntitlements);
  });
});
