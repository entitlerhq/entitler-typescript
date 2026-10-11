import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ApiError,
  defineFeature,
  EntitlerClient,
  EntitlerServer,
  type ErrorCode,
  TokenError,
  VISITOR_ID_PATTERN,
} from "../../src/index.js";
import { fakeCustomer } from "../../src/testing.js";
import { apiError, checkAnswer, fakeFetch, json, jwt } from "./fake.js";

const credits = defineFeature("ai_credits", "metered");

afterEach(() => {
  vi.useRealTimers();
});

function token(n: number): string {
  return jwt({ sub: "user_1", n, exp: Math.floor(Date.now() / 1000) + 3600 });
}

describe("stale answers never cross principals", () => {
  it("fails, rather than answer an entry kept under the token a 401 replaced", async () => {
    let issued = 0;
    const provider = vi.fn(async () => token(++issued));
    let reads = 0;
    const { fetch } = fakeFetch(() => {
      reads += 1;
      if (reads === 1) return json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "private, max-age=0" });
      if (reads === 2) return apiError(401, "unauthorised");
      return apiError(503, "unavailable");
    });
    const errors: unknown[] = [];
    const client = new EntitlerClient({ token: provider, fetch, maxRetries: 1, onError: (e) => errors.push(e) });
    await client.me.check("export_pdf");
    vi.spyOn(Math, "random").mockReturnValue(0);
    await expect(client.me.check("export_pdf")).rejects.toMatchObject({ status: 503 });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });
});

describe("invalid_response", () => {
  it("never carries a cause that quotes the body", async () => {
    const minted = token(1);
    const { fetch } = fakeFetch(new Response(minted, { status: 200 }), new Response(`{"token":"${minted}"`));
    const server = new EntitlerServer({ key: "k", fetch, maxRetries: 0 });
    const error = await server
      .customer("user_1")
      .token()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_response");
    const messages: string[] = [];
    for (let link: unknown = error; link instanceof Error; link = link.cause) messages.push(link.message);
    expect(messages.join(" ")).not.toContain(minted);
    expect(messages.join(" ")).not.toContain("token");
    const truncated = await server
      .customer("user_1")
      .token()
      .catch((caught: unknown) => caught);
    expect(String((truncated as Error).cause)).not.toContain(minted);
  });
});

describe("a token provider's own abort", () => {
  it("is a TokenError, so isEntitled answers its default", async () => {
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const errors: unknown[] = [];
    const client = new EntitlerClient({
      token: async () => {
        throw new DOMException("The provider gave up.", "AbortError");
      },
      fetch,
      onError: (e) => errors.push(e),
    });
    expect(await client.me.isEntitled("export_pdf", { default: true })).toBe(true);
    expect(errors[0]).toBeInstanceOf(TokenError);
    expect(sent).toHaveLength(0);
  });
});

describe("required fields that may be null", () => {
  it.each(["release", "change", "experiment"])("answers invalid_response when a check lacks %s", async (field) => {
    const body: Record<string, unknown> = checkAnswer();
    delete body[field];
    const { fetch } = fakeFetch(json(body));
    const server = new EntitlerServer({ key: "k", fetch, cache: false });
    await expect(server.customer("user_1").check("export_pdf")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["pending", "billedBy"])("answers invalid_response when a held plan lacks %s", async (field) => {
    const held: Record<string, unknown> = {
      plan: { id: "pln_free", key: "free", name: "Free", kind: "plan" },
      product: null,
      version: 1,
      byDefault: true,
      period: null,
      renewsAt: null,
      pending: null,
      billedBy: null,
    };
    delete held[field];
    const { customer: _, ...context } = checkAnswer();
    const { fetch } = fakeFetch(json({ ...context, customer: "user_1", held: [held], options: [] }));
    const server = new EntitlerServer({ key: "k", fetch, cache: false });
    await expect(server.customer("user_1").plans()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("per-call timeouts", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s before any request or token", async (timeout) => {
    const provider = vi.fn(async () => token(1));
    const { fetch, sent } = fakeFetch(json(checkAnswer()));
    const client = new EntitlerClient({ token: provider, fetch });
    await expect(client.me.check("export_pdf", { timeout })).rejects.toBeInstanceOf(RangeError);
    await expect(client.me.isEntitled("export_pdf", { default: true, timeout })).rejects.toBeInstanceOf(RangeError);
    expect(provider).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("an overlong Retry-After", () => {
  it("fails at once with a finite retryAfter, and the outage window ends within staleFor", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    let reads = 0;
    const { fetch, sent } = fakeFetch(() => {
      reads += 1;
      if (reads === 1) return json(checkAnswer(), 200, { etag: '"v1"', "cache-control": "private, max-age=0" });
      if (reads === 2) return apiError(503, "unavailable", "Down.", { "retry-after": "9".repeat(400) });
      return json(checkAnswer(), 200, { etag: '"v2"', "cache-control": "private, max-age=0" });
    });
    const errors: unknown[] = [];
    const server = new EntitlerServer({ key: "k", fetch, staleFor: 60_000, onError: (e) => errors.push(e) });
    const customer = server.customer("user_1");
    await customer.check("export_pdf");
    expect((await customer.check("export_pdf")).stale).toBe(true);
    expect(Number.isSafeInteger((errors[0] as ApiError).retryAfter)).toBe(true);
    vi.setSystemTime(61_000);
    expect((await customer.check("export_pdf")).stale).toBe(false);
    expect(sent).toHaveLength(3);
  });
});

describe("visitor ids", () => {
  it("refuse a trailing newline", async () => {
    expect(VISITOR_ID_PATTERN.test("abcdefghijklmnop")).toBe(true);
    expect(VISITOR_ID_PATTERN.test("abcdefghijklmnop\n")).toBe(false);
    const { fetch, sent } = fakeFetch(json({}));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("u");
    await expect(customer.pricing({ visitor: "abcdefghijklmnop\n" })).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
  });
});

describe("the fake's holds", () => {
  it("records the excess past the hold, and answers duplicate to an identical settlement", async () => {
    const customer = fakeCustomer({ ai_credits: { value: 100 } });
    const hold = await customer.startHold(credits, 10, { idempotencyKey: "job-1" });
    hold.use(14);
    expect(await hold.finish()).toMatchObject({ outcome: "settled", amount: 10 });
    expect((await customer.check(credits)).used).toBe(14);
    expect(await customer.settleUsage(hold.id, 10)).toMatchObject({ outcome: "duplicate" });
    await expect(customer.settleUsage(hold.id, 11)).rejects.toMatchObject({ status: 409, code: "hold_settled" });
    const other = await customer.startHold(credits, 5, { idempotencyKey: "job-2" });
    await expect(customer.settleUsage(other.id, 6)).rejects.toMatchObject({ status: 400, code: "invalid_body" });
  });
});

type Known<T> = T extends string ? (string extends T ? never : T) : never;

describe("error codes", () => {
  it("name internal and snapshot_key_unavailable among the known codes", () => {
    expectTypeOf<"internal">().toExtend<Known<ErrorCode>>();
    expectTypeOf<"snapshot_key_unavailable">().toExtend<Known<ErrorCode>>();
  });
});
