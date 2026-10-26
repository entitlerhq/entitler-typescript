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

export function apiError(
  status: number,
  code: string,
  reason: string | null = null,
  headers: Record<string, string> = {},
  parameters: Record<string, string> = {},
) {
  return json({ error: { code, reason, parameters } }, status, headers);
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

export const answerContext = {
  asOf: 1_791_507_600,
  customer: { customerId: "cu_1", externalId: "user_1" },
  served: { release: { id: "rl_1", number: 2 } },
};

export function wireEntitlement(overrides: Record<string, unknown> = {}) {
  return {
    entitled: true,
    featureKey: "export_pdf",
    kind: "ENTITLED_FEATURE_KIND_SWITCH",
    sources: [
      {
        plan: {
          planId: "pl_1",
          planKey: "pro",
          planName: "Pro",
          productId: "pr_1",
          versionNumber: 1,
          value: { switch: true },
        },
      },
    ],
    upgrades: [],
    value: { switch: true },
    ...overrides,
  };
}

export function checkAnswer(overrides: Record<string, unknown> = {}) {
  return { ...answerContext, entitlement: wireEntitlement(overrides) };
}

export function usageAnswer(usage: Record<string, unknown> = {}, tracked: Record<string, unknown> = {}) {
  const { outcome = "recorded", mode = "gate", refusal, ...rest } = usage;
  return {
    tracked: {
      ...answerContext,
      entitlement: wireEntitlement({
        featureKey: "ai_credits",
        kind: "ENTITLED_FEATURE_KIND_METERED",
        value: { metered: { count: 1000 } },
        meter: { used: 10, remaining: { count: 990 } },
        sources: [],
      }),
      usage: {
        outcome: `USAGE_OUTCOME_${String(outcome).toUpperCase()}`,
        mode: `USAGE_MODE_${String(mode).toUpperCase()}`,
        ...(refusal === undefined ? {} : { refusal: `USAGE_REFUSAL_${String(refusal).toUpperCase()}` }),
        amount: 1,
        meterChange: 1,
        overBy: 0,
        late: false,
        replayed: false,
        ...rest,
      },
      ...tracked,
    },
  };
}
