import { vi } from "vitest";

export interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly path: string;
  readonly query: Record<string, string>;
}

export type Reply = Response | Error | ((sent: Sent, init: RequestInit) => Response | Promise<Response>);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(status: number, code: string, message = "Refused.", headers: Record<string, string> = {}) {
  return json({ error: { code, message } }, status, headers);
}

/** A fake fetch that answers from a queue and records each request. */
export function fakeFetch(...replies: Reply[]) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const record: Sent = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    };
    sent.push(record);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error("No reply queued.");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(record, init);
    return reply.clone();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, mock: fetch };
}

export function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.c2ln`;
}

export const context = {
  environment: { id: "env_1", name: "development", kind: "test" },
  track: { id: "trk_1", name: "All customers" },
  release: 2,
  change: null,
  testers: true,
  experiment: null,
};

export function checkAnswer(overrides: Record<string, unknown> = {}) {
  return {
    customer: "user_1",
    ...context,
    asOf: "2026-10-09T01:00:00.000Z",
    feature: "export_pdf",
    type: "boolean",
    entitled: true,
    value: true,
    sources: [{ type: "plan", plan: "pro", name: "Pro", version: 1, byDefault: false, value: true }],
    upgrades: [],
    ...overrides,
  };
}

export function usageAnswer(overrides: Record<string, unknown> = {}) {
  return {
    customer: "user_1",
    ...context,
    asOf: "2026-10-09T01:00:00.000Z",
    feature: "ai_credits",
    type: "metered",
    entitled: true,
    value: 300,
    sources: [],
    used: 3,
    held: 0,
    remaining: 297,
    resetsAt: "2026-11-01T00:00:00.000Z",
    upgrades: [],
    outcome: "recorded",
    refusal: null,
    id: "use_1",
    holdId: null,
    mode: "gate",
    amount: 3,
    meterChange: 3,
    overBy: 0,
    late: false,
    occurredAt: "2026-10-09T01:00:00.000Z",
    expiresAt: null,
    reportedAs: "api",
    ...overrides,
  };
}

export function pricingAnswer(overrides: Record<string, unknown> = {}) {
  return { ...context, customer: "user_1", defaultPlan: null, products: [], plans: [], ...overrides };
}

export function customerUsageAnswer(overrides: Record<string, unknown> = {}) {
  return {
    customer: "user_1",
    ...context,
    asOf: "2026-10-09T01:00:00.000Z",
    metersStartAgainAt: null,
    features: [],
    log: { items: [], next: null },
    ...overrides,
  };
}

export function detailsAnswer(overrides: Record<string, unknown> = {}) {
  return {
    customer: {
      id: "cus_1",
      externalId: "user_1",
      name: "Ada",
      email: "ada@example.com",
      environmentId: "env_1",
      sample: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      plan: null,
      plans: [],
      defaultPlan: null,
      status: "active",
      kind: "default",
      metadata: {},
      track: context.track,
      testCustomer: false,
    },
    asOf: "2026-10-09T01:00:00.000Z",
    subscription: null,
    defaultPlan: null,
    products: [],
    addOns: [],
    entitlements: [],
    banked: {},
    moveOptions: [],
    grants: [],
    usage: { items: [], next: null },
    activity: [],
    environment: context.environment,
    ...overrides,
  };
}

const change = {
  product: { key: "app", name: "App" },
  plan: { id: "pln_pro", key: "pro", name: "Pro" },
  quantity: null,
  effective: "now",
  at: "2026-10-09T01:00:00.000Z",
  until: null,
  changed: true,
};

/** A complete answer for whichever customer route a request names. */
export function answerFor(request: Sent): unknown {
  const { method, path } = request;
  if (/\/entitlements\/[^/]+$/.test(path)) return checkAnswer();
  if (path.endsWith("/entitlements")) {
    return { customer: "user_1", ...context, asOf: "2026-10-09T01:00:00.000Z", entitlements: [] };
  }
  if (path.endsWith("/plans")) {
    return { customer: "user_1", ...context, asOf: "2026-10-09T01:00:00.000Z", held: [], options: [] };
  }
  if (path.endsWith("/pricing")) return pricingAnswer();
  if (method === "GET" && path.endsWith("/usage")) return customerUsageAnswer();
  if (path.includes("/usage") || path.includes("/meters/")) return usageAnswer();
  if (path.includes("/grants")) {
    const grant = {
      id: "grt_1",
      feature: "sso",
      value: "",
      from: "2026-10-09T01:00:00.000Z",
      until: null,
      revokedAt: null,
      reason: "",
      by: "Server key",
      actor: null,
    };
    return { grant };
  }
  if (method === "POST" && path.endsWith("/subscription")) return { next: "done", ...change };
  if (path.endsWith("/plan") || path.includes("/add-ons") || path.includes("/subscription")) return change;
  if (path.endsWith("/snapshot-keys")) return { keys: [] };
  if (path.endsWith("/billing-portal")) return { provider: "stripe", url: "https://billing.stripe.com/p/1" };
  if (path.endsWith("/billing/sync")) return { changed: false };
  if (path.endsWith("/billing")) {
    return { provider: null, status: null, sku: null, items: 0, drift: null, products: [] };
  }
  if (path.endsWith("/tokens")) {
    return { token: "a.b.c", customer: "user_1", scopes: ["entitlements:read"], expiresAt: "2026-10-09T02:00:00.000Z" };
  }
  if (path.endsWith("/snapshots")) return { token: "a.b.c", expiresAt: "2026-10-10T01:00:00.000Z", keyId: "key_1" };
  if (path.endsWith("/track")) {
    return {
      customer: "user_1",
      environmentId: "env_1",
      track: context.track,
      source: "server",
      previousTrackId: null,
    };
  }
  if (method === "PUT" && /^\/customers\/[^/]+$/.test(path)) {
    return {
      id: "cus_1",
      externalId: "user_1",
      environmentId: "env_1",
      createdAt: "2026-10-01T00:00:00.000Z",
      created: true,
    };
  }
  if (method === "PATCH") return detailsAnswer().customer;
  return detailsAnswer();
}
