import { describe, expect, it, vi } from "vitest";
import {
  defineFeature,
  EntitlerServer,
  type HoldContext,
  UsageRefusedError,
  UsageReplayedError,
  type UsageResult,
  UsageSettlementError,
} from "../../src/index.js";
import { apiError, fakeFetch, json, type Reply, type Sent, usageAnswer } from "./fake.js";

const aiCredits = defineFeature("ai_credits", "metered");
const key = { idempotencyKey: "job-7" };
const HOLDS = "/v1/customers/user_1/usage/holds";

function setup(...replies: Reply[]) {
  const fake = fakeFetch(...replies);
  return { ...fake, customer: new EntitlerServer({ key: "k", fetch: fake.fetch, cache: false }).customer("user_1") };
}

function holdFlow(settle: unknown = usageAnswer({ outcome: "settled" }), hold: Record<string, unknown> = {}) {
  return setup((request) => {
    if (request.path === HOLDS) {
      return json(
        usageAnswer({ outcome: "held", holdId: "hold_1", amount: 500, expiresAtMs: 32_503_680_000_000, ...hold }),
      );
    }
    if (request.path.endsWith(":settle")) return settle instanceof Response ? settle : json(settle);
    if (request.method === "DELETE") return json(usageAnswer({ outcome: "released" }));
    return json(usageAnswer({ mode: "observe" }));
  });
}

const paths = (sent: Sent[]) => sent.map((request) => request.method + request.path);

describe("recordUsage", () => {
  it("records usage and decodes the answer with the feature's entitlement", async () => {
    const { customer, sent } = setup(
      json(usageAnswer({ usageId: "us_1", amount: 3, occurredAtMs: 1_791_507_500_000 })),
    );
    const result = await customer.recordUsage(aiCredits, 3, {
      ...key,
      mode: "observe",
      occurredAt: new Date(1_791_507_500_000),
      register: true,
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/usage",
      body: {
        featureKey: "ai_credits",
        amount: 3,
        idempotencyKey: "job-7",
        mode: "USAGE_MODE_OBSERVE",
        occurredAtMs: 1_791_507_500_000,
        register: true,
      },
    });
    expect(result).toMatchObject({
      customer: "user_1",
      nextChangeAt: null,
      key: "ai_credits",
      type: "metered",
      meter: { used: 10, remaining: 990 },
      outcome: "recorded",
      refusal: null,
      id: "us_1",
      holdId: null,
      mode: "gate",
      amount: 3,
      meterChange: 1,
      overBy: 0,
      late: false,
      occurredAt: new Date(1_791_507_500_000),
      expiresAt: null,
      replayed: false,
    });
  });

  it("answers a gated refusal instead of throwing", async () => {
    const { customer } = setup(json(usageAnswer({ outcome: "refused", refusal: "over_allowance", meterChange: 0 })));
    expect(await customer.recordUsage(aiCredits, 2000, key)).toMatchObject({
      outcome: "refused",
      refusal: "over_allowance",
    });
  });

  it("retries a keyed report", async () => {
    const { customer, sent } = setup(apiError(503, "Unavailable"), json(usageAnswer()));
    await customer.recordUsage(aiCredits, 1, key);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
  });

  it("refuses a bad amount or date before any request", async () => {
    const { customer, mock } = setup(json(usageAnswer()));
    await expect(customer.recordUsage(aiCredits, 0, key)).rejects.toThrow(RangeError);
    await expect(customer.recordUsage(aiCredits, 1, { ...key, occurredAt: new Date(Number.NaN) })).rejects.toThrow(
      "Pass occurredAt as a valid date.",
    );
    await expect(customer.holdUsage(aiCredits, 1, { ...key, ttlSeconds: 3601 })).rejects.toThrow(RangeError);
    await expect(customer.settleUsage("h", -1)).rejects.toThrow(
      "Pass amount as a whole number from 0 to the held amount.",
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("holds", () => {
  it("answers a handle for a hold, and finishes with the amount reported", async () => {
    const { customer, sent } = holdFlow();
    const hold = await customer.startHold(aiCredits, 500, { ...key, ttlSeconds: 120 });
    expect(hold).toMatchObject({ id: "hold_1", amount: 500, duplicate: false });
    expect(hold.expiresAt).toEqual(new Date(32_503_680_000_000));
    expect(hold.result.outcome).toBe("held");
    hold.use(200);
    hold.use(120);
    expect((await hold.finish()).outcome).toBe("settled");
    expect(sent.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", HOLDS, { featureKey: "ai_credits", amount: 500, idempotencyKey: "job-7", ttlSeconds: 120 }],
      ["POST", `${HOLDS}/hold_1:settle`, { amount: 120 }],
    ]);
  });

  it("finishes with the held amount when none is reported, and 0 after use(0)", async () => {
    const { customer, sent } = holdFlow();
    await (await customer.startHold(aiCredits, 500, key)).finish();
    const streamed = await customer.startHold(aiCredits, 500, key);
    streamed.use(0);
    await streamed.finish();
    expect(sent.filter((request) => request.path.endsWith(":settle")).map((request) => request.body)).toEqual([
      { amount: 500 },
      { amount: 0 },
    ]);
  });

  it("judges a duplicate open by the answer's asOf, not the local clock", async () => {
    vi.useFakeTimers({ now: new Date("2999-01-01T00:00:00Z"), toFake: ["Date"] });
    try {
      const open = holdFlow(undefined, { outcome: "duplicate", expiresAtMs: 1_791_507_900_000 });
      expect((await open.customer.startHold(aiCredits, 500, key)).duplicate).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const expired = holdFlow(undefined, { outcome: "duplicate", expiresAtMs: 1_791_507_600_000 });
    await expect(expired.customer.startHold(aiCredits, 500, key)).rejects.toBeInstanceOf(UsageReplayedError);
  });

  it("runs withHold's work on another caller's hold, and leaves that hold to its owner", async () => {
    const { customer, sent } = holdFlow(undefined, { outcome: "duplicate", expiresAtMs: 1_791_507_900_000 });
    const seen = await customer.withHold(aiCredits, 500, ({ hold }) => hold.duplicate, key);
    expect(seen).toBe(true);
    const failure = new Error("failed");
    await expect(
      customer.withHold(
        aiCredits,
        500,
        () => {
          throw failure;
        },
        key,
      ),
    ).rejects.toBe(failure);
    expect(paths(sent)).toEqual([`POST${HOLDS}`, `POST${HOLDS}`]);
  });

  it("acts only on the first of finish, release and disposal", async () => {
    const { customer, sent } = holdFlow();
    const hold = await customer.startHold(aiCredits, 500, key);
    const released = await hold.release();
    expect(released.outcome).toBe("released");
    expect(await hold.finish()).toBe(released);
    await hold[Symbol.asyncDispose]();
    expect(paths(sent)).toEqual([`POST${HOLDS}`, `DELETE${HOLDS}/hold_1`]);
  });

  it("disposes by settling the amount reported, else by releasing", async () => {
    const { customer, sent } = holdFlow();
    {
      await using hold = await customer.startHold(aiCredits, 500, key);
      hold.use(40);
    }
    {
      await using _hold = await customer.startHold(aiCredits, 500, key);
    }
    expect(paths(sent).slice(1)).toEqual([`POST${HOLDS}/hold_1:settle`, `POST${HOLDS}`, `DELETE${HOLDS}/hold_1`]);
    expect(sent[1]?.body).toEqual({ amount: 40 });
  });

  it("passes a failed disposal to onError as a UsageSettlementError, and never throws", async () => {
    const onError = vi.fn();
    const { fetch } = fakeFetch((request) =>
      request.path.endsWith(":settle")
        ? apiError(400, "InvalidArgument", "SETTLE_AMOUNT_INVALID")
        : json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5, expiresAtMs: 32_503_680_000_000 })),
    );
    const customer = new EntitlerServer({ key: "k", fetch, onError }).customer("u");
    const hold = await customer.startHold(aiCredits, 5, key);
    hold.use(3);
    await expect(hold[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(UsageSettlementError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ holdId: "hold_1", amount: 3, result: undefined });
  });

  it("fails finish with UsageSettlementError", async () => {
    const { customer } = holdFlow(apiError(400, "InvalidArgument", "SETTLE_AMOUNT_INVALID"));
    const hold = await customer.startHold(aiCredits, 500, key);
    hold.use(520);
    const error = (await hold.finish().catch((e: unknown) => e)) as UsageSettlementError;
    expect(error).toMatchObject({
      name: "UsageSettlementError",
      holdId: "hold_1",
      settled: false,
      amount: 500,
      excess: 20,
    });
    expect(error.message).toBe(
      "Entitler could not settle hold hold_1. Settle it again with settleUsage() before it expires.",
    );
  });

  it("says the hold is closed when only recording the excess fails", async () => {
    const { fetch } = fakeFetch((request) => {
      if (request.path === HOLDS) {
        return json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 500, expiresAtMs: 32_503_680_000_000 }));
      }
      if (request.path.endsWith(":settle")) return json(usageAnswer({ outcome: "settled" }));
      return apiError(400, "InvalidArgument", "USAGE_KEY_MISMATCH");
    });
    const customer = new EntitlerServer({ key: "k", fetch }).customer("user_1");
    const hold = await customer.startHold(aiCredits, 500, key);
    hold.use(520);
    const error = (await hold.finish().catch((e: unknown) => e)) as UsageSettlementError;
    expect(error).toMatchObject({ settled: true, excess: 20, excessKey: "job-7:excess" });
    expect(error.message).toBe(
      "Hold hold_1 is closed, but Entitler could not record the 20 used beyond it. Record it in observe mode under the key job-7:excess.",
    );
  });

  it("refuses a hold with UsageRefusedError, carrying the answer", async () => {
    const { customer, sent } = setup(json(usageAnswer({ amount: 500, outcome: "refused", refusal: "over_allowance" })));
    const error = await customer.startHold(aiCredits, 500, key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageRefusedError);
    expect(error).toMatchObject({
      message: "The customer has too little ai_credits left for 500.",
      result: { refusal: "over_allowance" },
    });
    expect(sent).toHaveLength(1);
  });

  it("explains a refusal for a feature the customer lacks", () => {
    const result = { key: "ai_credits", amount: 5, refusal: "not_entitled" } as UsageResult;
    expect(new UsageRefusedError(result).message).toBe("The customer is not entitled to ai_credits.");
  });

  it.each([
    ["settled", { outcome: "settled" }],
    ["released", { outcome: "released" }],
  ])("refuses a key that repeats a %s hold with UsageReplayedError", async (_name, answer) => {
    const { customer } = setup(json(usageAnswer({ amount: 500, holdId: "hold_1", ...answer })));
    await expect(customer.startHold(aiCredits, 500, key)).rejects.toBeInstanceOf(UsageReplayedError);
  });

  it("refuses a hold, a report or a handle without a key before any request", async () => {
    const { customer, mock } = holdFlow();
    const loose = customer as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const message = "Pass idempotencyKey: a key from your own unit of work, such as a message or job id.";
    for (const call of [
      () => loose.recordUsage?.(aiCredits, 1, {}),
      () => loose.holdUsage?.(aiCredits, 1, {}),
      () => loose.startHold?.(aiCredits, 1, {}),
      () => loose.withHold?.(aiCredits, 1, () => 1, {}),
    ]) {
      await expect(call()).rejects.toThrow(new TypeError(message));
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses a key with no room for :excess", async () => {
    const { customer, mock } = holdFlow();
    await expect(customer.startHold(aiCredits, 5, { idempotencyKey: "k".repeat(194) })).rejects.toThrow(
      new TypeError("Pass idempotencyKey as 1 to 193 printable ASCII characters."),
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("records the excess, and the whole amount once the hold expired, under :excess", async () => {
    const { customer, sent } = holdFlow();
    await customer.withHold(aiCredits, 500, ({ hold }) => hold.use(650), { idempotencyKey: "job-8" });
    expect(sent[1]?.body).toEqual({ amount: 500 });
    expect(sent[2]).toMatchObject({
      path: "/v1/customers/user_1/usage",
      body: { amount: 150, mode: "USAGE_MODE_OBSERVE", idempotencyKey: "job-8:excess" },
    });
    const expired = holdFlow(apiError(400, "FailedPrecondition", "HOLD_EXPIRED"));
    const hold = await expired.customer.startHold(aiCredits, 500, { idempotencyKey: "job-9" });
    hold.use(320);
    expect((await hold.finish()).outcome).toBe("recorded");
    expect(expired.sent[2]).toMatchObject({
      body: { featureKey: "ai_credits", amount: 320, mode: "USAGE_MODE_OBSERVE", idempotencyKey: "job-9:excess" },
    });
  });

  it("sends a money feature's currency, and records its excess in the same currency", async () => {
    const spend = defineFeature("spend", "metered");
    const answer = (usage: Record<string, unknown>) => {
      const reply = usageAnswer(usage);
      Object.assign(reply.tracked.entitlement, { featureKey: "spend", decimals: 2, currency: "aud" });
      return json(reply);
    };
    const { customer, sent } = setup((request) => {
      if (request.path === HOLDS)
        return answer({ outcome: "held", holdId: "hold_1", amount: 500, expiresAtMs: 32_503_680_000_000 });
      if (request.path.endsWith(":settle")) return answer({ outcome: "settled" });
      return answer({ mode: "observe", saturated: true });
    });
    await customer.withHold(spend, 500, ({ hold }) => hold.use(650), { idempotencyKey: "job-8", currency: "aud" });
    expect(sent[0]?.body).toMatchObject({ featureKey: "spend", amount: 500, currency: "aud" });
    expect(sent[2]?.body).toMatchObject({ amount: 150, idempotencyKey: "job-8:excess", currency: "aud" });
    const recorded = await customer.recordUsage(spend, 250, { idempotencyKey: "job-9", currency: "aud" });
    expect(sent[3]?.body).toMatchObject({ amount: 250, currency: "aud" });
    expect(recorded).toMatchObject({ decimals: 2, currency: "aud", saturated: true });
    await expect(
      customer.recordUsage(spend, 1, { idempotencyKey: "job-10", currency: 36 as unknown as string }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("frees a hold that expired with nothing used", async () => {
    const { customer, sent } = holdFlow(apiError(400, "FailedPrecondition", "HOLD_EXPIRED"));
    const hold = await customer.startHold(aiCredits, 500, key);
    hold.use(0);
    expect((await hold.finish()).outcome).toBe("released");
    expect(paths(sent).at(-1)).toBe(`DELETE${HOLDS}/hold_1`);
  });

  it("retries a settlement that timed out or raced another change", async () => {
    let settles = 0;
    const { fetch, sent } = fakeFetch((request, init) => {
      if (request.path === HOLDS) {
        return json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5, expiresAtMs: 32_503_680_000_000 }));
      }
      settles += 1;
      if (settles === 1) {
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        );
      }
      if (settles === 2) return apiError(409, "Aborted", "HOLD_CHANGED");
      return json(usageAnswer({ outcome: "settled" }));
    });
    const customer = new EntitlerServer({ key: "k", fetch, maxRetries: 2 }).customer("user_1");
    const hold = await customer.startHold(aiCredits, 5, { ...key, timeout: 20 });
    expect((await hold.finish()).outcome).toBe("settled");
    expect(sent.filter((request) => request.path.endsWith(":settle"))).toHaveLength(3);
  });

  it("doesn't call a hold another caller's when it answers the SDK's own retry", async () => {
    const duplicate = usageAnswer({
      outcome: "duplicate",
      holdId: "hold_1",
      amount: 5,
      expiresAtMs: 32_503_680_000_000,
    });
    const { customer } = setup(apiError(503, "Unavailable"), json(duplicate));
    expect((await customer.startHold(aiCredits, 5, key)).duplicate).toBe(false);
  });

  it("refuses a reported amount that is not a whole number", async () => {
    const { customer } = holdFlow();
    const hold = await customer.startHold(aiCredits, 500, key);
    expect(() => hold.use(-1)).toThrow(new RangeError("Pass the amount used as a whole number of 0 or more."));
  });
});

describe("withHold", () => {
  it("runs the work with the hold and its signal, finishes, and answers the work's result", async () => {
    const { customer, sent } = holdFlow();
    const work = vi.fn(async ({ hold }: HoldContext) => {
      hold.use(120);
      return { text: "done" };
    });
    expect(await customer.withHold(aiCredits, 500, work, key)).toEqual({ text: "done" });
    expect(work.mock.calls[0]?.[0].hold).toMatchObject({ id: "hold_1", amount: 500, duplicate: false });
    expect(work.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(sent[1]?.body).toEqual({ amount: 120 });
  });

  it("releases when the work fails before reporting, and settles what it reported after", async () => {
    const before = holdFlow();
    const failure = new Error("model crashed");
    await expect(before.customer.withHold(aiCredits, 500, () => Promise.reject(failure), key)).rejects.toBe(failure);
    expect(before.sent.at(-1)?.method).toBe("DELETE");
    const after = holdFlow();
    await expect(
      after.customer.withHold(
        aiCredits,
        500,
        ({ hold }) => {
          hold.use(300);
          throw failure;
        },
        key,
      ),
    ).rejects.toBe(failure);
    expect(after.sent.at(-1)).toMatchObject({ path: `${HOLDS}/hold_1:settle`, body: { amount: 300 } });
  });

  it("closes a cancelled hold when it expires by the server's clock, if its work never stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const { customer, sent } = holdFlow(undefined, { expiresAtMs: 1_791_507_600_060 });
      const controller = new AbortController();
      let started = false;
      const call = customer.withHold(
        aiCredits,
        500,
        ({ hold }) => {
          hold.use(30);
          started = true;
          return new Promise(() => {});
        },
        { ...key, signal: controller.signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);
      controller.abort(Number.NaN);
      await expect(call).rejects.toBeNaN();
      await vi.advanceTimersByTimeAsync(59);
      expect(paths(sent)).toEqual([`POST${HOLDS}`]);
      await vi.advanceTimersByTimeAsync(2);
      expect(sent.at(-1)).toMatchObject({ path: `${HOLDS}/hold_1:settle`, body: { amount: 30 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a cancellation on at once, and keeps the hold until the work stops", async () => {
    const { customer, sent } = holdFlow();
    const controller = new AbortController();
    let stop: (() => void) | undefined;
    const call = customer.withHold(
      aiCredits,
      500,
      ({ hold }) => {
        hold.use(30);
        controller.abort();
        return new Promise<void>((resolve) => {
          stop = () => {
            hold.use(45);
            resolve();
          };
        });
      },
      { ...key, signal: controller.signal },
    );
    expect(await call.catch((e: unknown) => e)).toBe(controller.signal.reason);
    expect(paths(sent)).toEqual([`POST${HOLDS}`]);
    stop?.();
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ path: `${HOLDS}/hold_1:settle`, body: { amount: 45 } }));
  });

  it("settles a cancelled hold with the usage its work reported before it rejected, before expiry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const { customer, sent } = holdFlow(undefined, { expiresAtMs: 1_791_507_600_060 });
      const controller = new AbortController();
      let fail: (() => void) | undefined;
      const call = customer.withHold(
        aiCredits,
        500,
        ({ hold }) => {
          hold.use(30);
          return new Promise<void>((_, reject) => {
            fail = () => {
              hold.use(45);
              reject(new Error("stopped"));
            };
          });
        },
        { ...key, signal: controller.signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(Number.NaN);
      await expect(call).rejects.toBeNaN();
      expect(paths(sent)).toEqual([`POST${HOLDS}`]);
      fail?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.at(-1)).toMatchObject({ path: `${HOLDS}/hold_1:settle`, body: { amount: 45 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the hold without running the work when the call was cancelled while it was held", async () => {
    const controller = new AbortController();
    const { customer, sent } = setup((request) => {
      if (request.method === "DELETE") return json(usageAnswer({ outcome: "released" }));
      controller.abort();
      return json(usageAnswer({ outcome: "held", holdId: "hold_1", amount: 5, expiresAtMs: 32_503_680_000_000 }));
    });
    const work = vi.fn();
    await expect(customer.withHold(aiCredits, 5, work, { ...key, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(work).not.toHaveBeenCalled();
    expect(sent.at(-1)?.method).toBe("DELETE");
  });

  it("fails a settlement with UsageSettlementError carrying the work's result", async () => {
    const { customer } = holdFlow(apiError(400, "InvalidArgument", "SETTLE_AMOUNT_INVALID"));
    const error = (await customer
      .withHold(
        aiCredits,
        500,
        ({ hold }) => {
          hold.use(520);
          return "summary";
        },
        key,
      )
      .catch((e: unknown) => e)) as UsageSettlementError;
    expect(error).toMatchObject({ holdId: "hold_1", amount: 500, excess: 20, result: "summary" });
    expect((error.cause as { reason: string }).reason).toBe("SETTLE_AMOUNT_INVALID");
  });

  it("refuses work that is not a function", async () => {
    const { customer, mock } = holdFlow();
    await expect(customer.withHold(aiCredits, 5, "work" as never, key)).rejects.toThrow("Pass work as a function.");
    expect(mock).not.toHaveBeenCalled();
  });
});
