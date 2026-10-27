import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  EntitlerClient,
  EntitlerServer,
  SnapshotError,
  type SnapshotKey,
  type VerifiedSnapshot,
  verifySnapshot,
} from "../../src/index.js";
import { fakeFetch, json } from "./fake.js";

const ISSUED = 1_791_507_600;
const NOW = new Date((ISSUED + 1) * 1000);

const claims = {
  iss: "entitler",
  sub: "user_1",
  environment: { id: "en_1" },
  track: { id: "tr_1", name: "Main" },
  release: { id: "rl_1", number: 2 },
  entitlements: [
    {
      key: "export_pdf",
      kind: "switch",
      value: true,
      entitled: true,
      sources: [
        {
          type: "plan",
          plan: { id: "pl_1", key: "pro", name: "Pro" },
          version: 1,
          product: "pr_1",
          value: true,
          through: null,
        },
      ],
    },
    {
      key: "ai_credits",
      kind: "metered",
      value: 1000,
      entitled: true,
      sources: [
        {
          type: "default_plan",
          plan: { id: "pl_0", key: "free", name: "Free" },
          version: 3,
          product: null,
          through: null,
        },
        {
          type: "add_on",
          plan: { id: "pl_2", key: "boost", name: "Boost" },
          version: 1,
          quantity: 2,
          value: "unlimited",
          through: "bundle",
        },
        { type: "grant", grant: "gr_1", until: 1_793_491_200, value: 500, through: null },
        { type: "group", features: ["ai_chat"] },
        { type: "brand_new" },
      ],
      decimals: 0,
      used: 10,
      held: 2,
      banked: 0,
      remaining: 990,
      resetsAt: 1_793_491_200,
    },
    { key: "api", kind: "switch", value: null, entitled: false, sources: [] },
  ],
  iat: ISSUED,
  exp: ISSUED + 86_400,
};

const header = { alg: "ES256", typ: "entitlements+jwt", kid: "1" };
let pair: CryptoKeyPair;
let key: SnapshotKey;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function sign(body: unknown = claims, head: unknown = header): Promise<string> {
  const signed = `${encode(head)}.${encode(body)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}

const expected = () => ({ keys: { keys: [key] }, customer: "user_1", environment: "en_1", now: NOW });

beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  key = { kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: "1", x: jwk.x as string, y: jwk.y as string };
});

describe("verifySnapshot", () => {
  it("verifies a snapshot and answers the entitlements it signs", async () => {
    const snapshot: VerifiedSnapshot = await verifySnapshot(await sign(), expected());
    expect(snapshot).toMatchObject({
      customer: "user_1",
      environment: "en_1",
      issuedAt: new Date(ISSUED * 1000),
      expiresAt: new Date((ISSUED + 86_400) * 1000),
    });
    const { entitlements } = snapshot;
    expect(entitlements).toMatchObject({
      customer: "user_1",
      customerId: null,
      asOf: new Date(ISSUED * 1000),
      nextChangeAt: null,
      stale: false,
      served: { track: { id: "tr_1", name: "Main" }, source: { type: "release", id: "rl_1", number: 2 } },
    });
    expect(entitlements.has("export_pdf")).toBe(true);
    expect(entitlements.has("api")).toBe(false);
    expect(entitlements.get("api")).toMatchObject({ value: 0, meter: null, upgrades: [] });
    expect(entitlements.get("ai_credits")).toEqual({
      key: "ai_credits",
      type: "metered",
      entitled: true,
      value: 1000,
      upgrades: [],
      meter: { used: 10, held: 2, banked: 0, remaining: 990, resetsAt: new Date(1_793_491_200_000) },
      sources: [
        {
          type: "plan",
          planId: "pl_0",
          plan: "free",
          name: "Free",
          product: null,
          version: 3,
          byDefault: true,
          value: null,
          through: null,
        },
        {
          type: "addon",
          planId: "pl_2",
          plan: "boost",
          name: "Boost",
          version: 1,
          quantity: 2,
          value: "unlimited",
          through: "bundle",
        },
        { type: "grant", grant: "gr_1", until: new Date(1_793_491_200_000), value: 500, through: null },
        { type: "group", features: ["ai_chat"] },
      ],
    });
  });

  it("takes the keys as an array, and allows clock skew", async () => {
    const early = new Date((ISSUED - 30) * 1000);
    await expect(verifySnapshot(await sign(), { ...expected(), keys: [key], now: early })).resolves.toBeDefined();
    await expect(
      verifySnapshot(await sign(), { ...expected(), now: early, clockSkewSeconds: 0 }),
    ).rejects.toMatchObject({ message: "The snapshot was signed in the future." });
  });

  it.each([
    ["a malformed token", async () => "a.b", "The snapshot is not a compact JWS."],
    [
      "another type",
      async () => sign(claims, { ...header, typ: "JWT" }),
      "The snapshot's header is not an Entitler snapshot's.",
    ],
    [
      "a critical header",
      async () => sign(claims, { ...header, crit: ["exp"] }),
      "The snapshot's header is not an Entitler snapshot's.",
    ],
    [
      "a signature that is not base64url",
      async () => `${(await sign()).split(".").slice(0, 2).join(".")}.A`,
      "The snapshot is not a compact JWS.",
    ],
    [
      "an unknown key",
      async () => sign(claims, { ...header, kid: "2" }),
      "None of the keys passed signed this snapshot.",
    ],
    [
      "edited claims",
      async () => {
        const [head, , signature] = (await sign()).split(".");
        return `${head}.${encode({ ...claims, sub: "user_2" })}.${signature}`;
      },
      "The snapshot's signature doesn't verify.",
    ],
    [
      "claims of another shape",
      async () => sign({ ...claims, sub: 7 }),
      "The snapshot's claims are not an Entitler snapshot's.",
    ],
    [
      "an expiry beyond any date",
      async () => sign({ ...claims, exp: Number.MAX_SAFE_INTEGER }),
      "The snapshot's claims are not an Entitler snapshot's.",
    ],
    ["another issuer", async () => sign({ ...claims, iss: "someone" }), "Entitler did not issue this snapshot."],
    ["another customer", async () => sign({ ...claims, sub: "user_2" }), "The snapshot is for another customer."],
    [
      "another environment",
      async () => sign({ ...claims, environment: { id: "en_2" } }),
      "The snapshot is for another environment.",
    ],
  ])("refuses %s as SNAPSHOT_INVALID", async (_, token, message) => {
    const error = await verifySnapshot(await token(), expected()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnapshotError);
    expect(error).toMatchObject({ reason: "SNAPSHOT_INVALID", message });
  });

  it("refuses an expired snapshot as SNAPSHOT_EXPIRED", async () => {
    const later = new Date((ISSUED + 86_400) * 1000);
    await expect(verifySnapshot(await sign(), { ...expected(), now: later })).rejects.toMatchObject({
      reason: "SNAPSHOT_EXPIRED",
      message: "The snapshot expired.",
    });
  });

  it("refuses missing expectations with TypeError", async () => {
    const token = await sign();
    await expect(verifySnapshot(token, { ...expected(), customer: "" })).rejects.toBeInstanceOf(TypeError);
    await expect(verifySnapshot(token, { ...expected(), clockSkewSeconds: 301 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("snapshots over the API", () => {
  it("asks Entitler to sign a snapshot for the lifetime asked for", async () => {
    const { fetch, sent } = fakeFetch(json({ token: "t.o.k", keyId: "1", expiresAt: ISSUED + 86_400 }));
    const customer = new EntitlerServer({ key: "k", fetch }).customer("user_1");
    expect(await customer.snapshot({ ttlSeconds: 86_400 })).toEqual({
      token: "t.o.k",
      keyId: "1",
      expiresAt: new Date((ISSUED + 86_400) * 1000),
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers/user_1/snapshots",
      body: { lifetimeSeconds: 86_400 },
    });
    await expect(customer.snapshot({ ttlSeconds: 59 })).rejects.toBeInstanceOf(RangeError);
  });

  it("fetches the keys without a credential, keeps them for their max-age, and skips other kinds", async () => {
    const other = { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: "9", x: "x" };
    const { fetch, sent } = fakeFetch(json({ keys: [key, other] }, 200, { "cache-control": "public, max-age=300" }));
    const token = vi.fn(async () => "ct_1");
    const entitler = new EntitlerClient({ token, fetch });
    expect(await entitler.snapshotKeys()).toEqual({ keys: [key] });
    expect(await entitler.snapshotKeys()).toEqual({ keys: [key] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/v1/snapshot-keys" });
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(token).not.toHaveBeenCalled();
  });
});
