import { describe, expect, it } from "vitest";
import { EntitlerClient, EntitlerServer, SnapshotError, type SnapshotKey, verifySnapshot } from "../../src/index.js";

const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const text = (value: unknown) =>
  encode(new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

async function publicKey(keys: CryptoKeyPair, kid: string): Promise<SnapshotKey> {
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string, kid, alg: "ES256", use: "sig" };
}

const key = await publicKey(pair, "snap_1");
const NOW = new Date("2026-10-09T00:00:00.000Z");
const iat = NOW.getTime() / 1000 - 60;

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://api.entitler.dev/customers",
    sub: "user_1",
    environment: { id: "env_1" },
    track: { id: "trk_1", name: "All customers" },
    release: 2,
    change: null,
    testers: true,
    payments: "test",
    entitlements: [
      { key: "export_pdf", type: "boolean", entitled: true, value: true, sources: [] },
      {
        key: "ai_credits",
        type: "metered",
        entitled: true,
        value: 300,
        sources: [],
        used: 3,
        held: 0,
        remaining: 297,
        resetsAt: "2026-11-01T00:00:00Z",
      },
      {
        key: "collaboration",
        type: "group",
        entitled: false,
        value: 0,
        sources: [{ type: "group", features: ["team_seats"] }],
      },
    ],
    iat,
    exp: iat + 3600,
    ...overrides,
  };
}

async function sign(
  payload: unknown,
  options: { header?: Record<string, unknown>; keys?: CryptoKeyPair; raw?: string } = {},
): Promise<string> {
  const header = text(options.header ?? { alg: "ES256", typ: "entitlements+jwt", kid: "snap_1" });
  const body = options.raw ?? text(payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    (options.keys ?? pair).privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${encode(new Uint8Array(signature))}`;
}

const expected = { keys: [key], customer: "user_1", environment: "env_1", now: NOW };

async function failure(token: string, overrides: Record<string, unknown> = {}) {
  const error = await verifySnapshot(token, { ...expected, ...overrides }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SnapshotError);
  return error as SnapshotError;
}

const NOT_A_SNAPSHOT = "That is not an entitlements snapshot. Pass the token snapshot() returned.";

describe("verifySnapshot", () => {
  it("verifies a snapshot and builds its entitlements", async () => {
    const snapshot = await verifySnapshot(await sign(claims()), expected);
    expect(snapshot).toMatchObject({
      customer: "user_1",
      environment: { id: "env_1" },
      track: { id: "trk_1", name: "All customers" },
      release: 2,
      change: null,
      testers: true,
      expiresAt: new Date((iat + 3600) * 1000),
    });
    expect(snapshot.entitlements.has("export_pdf")).toBe(true);
    expect(snapshot.entitlements.has("collaboration")).toBe(false);
    expect(snapshot.entitlements.get("ai_credits")?.resetsAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(snapshot.entitlements.asOf).toEqual(new Date(iat * 1000));
    expect(snapshot.entitlements.experiment).toBeNull();
    expect(snapshot.entitlements.environment).toEqual({ id: "env_1" });
  });

  it("takes a key set as well as a key list, and is on both clients", async () => {
    const token = await sign(claims());
    await expect(verifySnapshot(token, { ...expected, keys: { keys: [key] } })).resolves.toBeTruthy();
    await expect(new EntitlerServer({ key: "k" }).verifySnapshot(token, expected)).resolves.toBeTruthy();
    await expect(new EntitlerClient({ token: "t" }).verifySnapshot(token, expected)).resolves.toBeTruthy();
  });

  it("uses the system clock by default", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { now: _now, ...rest } = expected;
    await expect(verifySnapshot(await sign(claims({ iat: now, exp: now + 60 })), rest)).resolves.toBeTruthy();
  });

  it.each([
    ["three segments", "a.b"],
    ["a header that is not base64url", "@@@.e30.c2ln"],
    ["a header that is not JSON", `${text("not json")}.e30.c2ln`],
    ["a signature that is not base64url", `${text({ alg: "ES256", typ: "entitlements+jwt", kid: "snap_1" })}.e30.@@`],
  ])("refuses a token without %s", async (_name, token) => {
    const error = await failure(token);
    expect(error).toMatchObject({ code: "snapshot_invalid", message: NOT_A_SNAPSHOT, name: "SnapshotError" });
  });

  it("refuses a token that is not a string", async () => {
    expect((await failure(42 as never)).message).toBe(NOT_A_SNAPSHOT);
  });

  it.each([
    [{ alg: "ES256", typ: "JWT", kid: "snap_1" }],
    [{ alg: "RS256", typ: "entitlements+jwt", kid: "snap_1" }],
    [{ alg: "none", typ: "entitlements+jwt", kid: "snap_1" }],
  ])("refuses the header %j", async (header) => {
    expect((await failure(await sign(claims(), { header }))).message).toBe(NOT_A_SNAPSHOT);
  });

  it("refuses a header that is an array", async () => {
    expect((await failure(await sign(claims(), { header: [] as never }))).message).toBe(NOT_A_SNAPSHOT);
  });

  it("refuses a snapshot none of the keys signed", async () => {
    const error = await failure(
      await sign(claims(), { header: { alg: "ES256", typ: "entitlements+jwt", kid: "snap_9" } }),
    );
    expect(error.message).toBe("None of the keys passed signed this snapshot. Fetch them again with snapshotKeys().");
  });

  it("refuses a changed snapshot", async () => {
    const token = await sign(claims());
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${text(claims({ sub: "someone_else" }))}.${signature}`;
    const error = await failure(tampered, { customer: "someone_else" });
    expect(error).toMatchObject({
      code: "snapshot_invalid",
      message: "This snapshot was changed after Entitler signed it.",
    });
  });

  it("refuses a snapshot signed by another key under the same kid", async () => {
    const error = await failure(await sign(claims(), { keys: other }));
    expect(error.message).toBe("This snapshot was changed after Entitler signed it.");
  });

  it("refuses a signature that is not 64 bytes", async () => {
    const [header, payload] = (await sign(claims())).split(".");
    expect((await failure(`${header}.${payload}.${encode(new Uint8Array(70))}`)).message).toBe(
      "This snapshot was changed after Entitler signed it.",
    );
  });

  it("refuses a key that cannot be imported", async () => {
    const error = await failure(await sign(claims()), { keys: [{ ...key, x: "AAAA" }] });
    expect(error.message).toBe("This snapshot was changed after Entitler signed it.");
  });

  it.each([
    ["a missing iss", { iss: undefined }],
    ["a numeric sub", { sub: 1 }],
    ["an environment without an id", { environment: {} }],
    ["a track without a name", { track: { id: "t" } }],
    ["a fractional release", { release: 1.5 }],
    ["a numeric change", { change: 3 }],
    ["payments but no testers", { testers: undefined }],
    ["entitlements that are not a list", { entitlements: {} }],
    ["an entitlement without a key", { entitlements: [{}] }],
    ["a string iat", { iat: "now" }],
    ["a missing exp", { exp: undefined }],
  ])("refuses claims with %s", async (_name, overrides) => {
    const error = await failure(await sign(claims(overrides)));
    expect(error).toMatchObject({ code: "snapshot_invalid", message: NOT_A_SNAPSHOT });
  });

  it("refuses claims that are not JSON or not an object", async () => {
    expect((await failure(await sign(undefined, { raw: text("{not json") }))).message).toBe(NOT_A_SNAPSHOT);
    expect((await failure(await sign([1, 2]))).message).toBe(NOT_A_SNAPSHOT);
  });

  it("accepts a change in place of a release", async () => {
    const snapshot = await verifySnapshot(await sign(claims({ release: null, change: "chg_1" })), expected);
    expect(snapshot).toMatchObject({ release: null, change: "chg_1" });
  });

  it("checks the issuer", async () => {
    const error = await failure(await sign(claims({ iss: "https://evil.example" })));
    expect(error.message).toBe("This snapshot was not issued by https://api.entitler.dev/customers.");
    await expect(
      verifySnapshot(await sign(claims({ iss: "https://local.test" })), { ...expected, issuer: "https://local.test" }),
    ).resolves.toBeTruthy();
  });

  it("refuses a snapshot signed in the future beyond the skew", async () => {
    const future = NOW.getTime() / 1000 + 61;
    const error = await failure(await sign(claims({ iat: future, exp: future + 600 })));
    expect(error.message).toBe(
      "This snapshot was signed for 2026-10-09T00:01:01.000Z, which is still to come. Fetch a new one while online.",
    );
    await expect(
      verifySnapshot(await sign(claims({ iat: future - 1, exp: future + 600 })), expected),
    ).resolves.toBeTruthy();
    await expect(
      verifySnapshot(await sign(claims({ iat: future + 200, exp: future + 600 })), {
        ...expected,
        clockSkewSeconds: 300,
      }),
    ).resolves.toBeTruthy();
    expect((await failure(await sign(claims({ iat: NOW.getTime() / 1000 + 1 })), { clockSkewSeconds: 0 })).code).toBe(
      "snapshot_invalid",
    );
  });

  it("refuses an expired snapshot", async () => {
    const error = await failure(await sign(claims({ exp: NOW.getTime() / 1000 })));
    expect(error).toMatchObject({
      code: "snapshot_expired",
      message: "This snapshot expired at 2026-10-09T00:00:00.000Z. Fetch a new one while online.",
    });
  });

  it("refuses a snapshot for another customer", async () => {
    const error = await failure(await sign(claims({ sub: "user_2" })));
    expect(error.message).toBe(
      "This snapshot is for another customer, not user_1. Fetch one for the signed-in customer while online.",
    );
  });

  it("refuses a snapshot from another environment", async () => {
    const error = await failure(await sign(claims({ environment: { id: "env_live" } })));
    expect(error.message).toBe(
      "This snapshot is from another environment, not env_1. Fetch one from your app's environment while online.",
    );
  });

  it.each([-1, 301, 1.5, "60"])("refuses clockSkewSeconds %j as a range error", async (clockSkewSeconds) => {
    await expect(verifySnapshot("a.b.c", { ...expected, clockSkewSeconds } as never)).rejects.toThrow(
      new RangeError("Pass clockSkewSeconds as a whole number from 0 to 300."),
    );
  });

  it("validates the expected values", async () => {
    await expect(verifySnapshot("a.b.c", { ...expected, customer: "" })).rejects.toThrow(TypeError);
    await expect(verifySnapshot("a.b.c", { ...expected, environment: " " })).rejects.toThrow(TypeError);
    await expect(verifySnapshot("a.b.c", { ...expected, keys: undefined as never })).rejects.toThrow(TypeError);
  });
});
