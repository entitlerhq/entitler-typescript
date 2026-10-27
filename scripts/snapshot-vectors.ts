import { writeFileSync } from "node:fs";
import { SnapshotError, type SnapshotKey, verifySnapshot } from "../src/index.js";

const OUT = new URL("../test/fixtures/snapshot-vectors.json", import.meta.url);
const ISSUED = 1_791_507_600;
const EXPIRES = ISSUED + 86_400;
const CUSTOMER = "user_1";
const ENVIRONMENT = "en_1";

type Claims = Record<string, unknown>;

const plan = (id: string, key: string, name: string) => ({ id, key, name });

const base: Claims = {
  iss: "entitler",
  sub: CUSTOMER,
  environment: { id: ENVIRONMENT },
  track: { id: "tr_1", name: "Main" },
  release: { id: "rl_1", number: 2 },
  iat: ISSUED,
  exp: EXPIRES,
};

const exportPdf = {
  key: "export_pdf",
  kind: "switch",
  value: true,
  entitled: true,
  sources: [
    { type: "plan", plan: plan("pl_1", "pro", "Pro"), version: 1, product: "pr_1", value: true, through: null },
  ],
};

const aiCredits = {
  key: "ai_credits",
  kind: "metered",
  value: 1000,
  entitled: true,
  sources: [
    { type: "default_plan", plan: plan("pl_0", "free", "Free"), version: 3, product: null, through: null },
    { type: "grant", grant: "gr_1", until: ISSUED + 3_600, value: 500, through: null },
  ],
  decimals: 0,
  used: 10,
  held: 2,
  banked: 0,
  remaining: 988,
  resetsAt: ISSUED + 2_592_000,
};

const addOns = {
  key: "seats",
  kind: "configuration",
  value: "unlimited",
  entitled: true,
  sources: [
    {
      type: "add_on",
      plan: plan("pl_2", "seats_pack", "Seats pack"),
      version: 1,
      quantity: 3,
      value: "unlimited",
      through: "team_pack",
    },
  ],
};

const money = [
  { marketId: "mk_au", limit: 5000 },
  { marketId: "mk_us", limit: "unlimited" },
];

const spend = {
  key: "spend",
  kind: "metered",
  value: money,
  entitled: true,
  sources: [{ type: "grant", grant: "gr_2", until: null, value: money, through: null }],
  decimals: 2,
  currency: "aud",
  used: 150,
  held: 0,
  banked: 0,
  remaining: 4850,
  resetsAt: null,
};

const group = {
  key: "team_pack",
  kind: "group",
  value: true,
  entitled: true,
  sources: [
    { type: "plan", plan: plan("pl_1", "pro", "Pro"), version: 1, product: "pr_1", value: true, through: null },
  ],
};

const member = {
  key: "shared_inbox",
  kind: "switch",
  value: true,
  entitled: true,
  sources: [{ type: "group", features: ["team_pack"] }, { type: "brand_new" }],
};

const noMeter = { key: "api_calls", kind: "metered", value: 0, entitled: false, sources: [] };

const header = (kid: string, typ = "entitlements+jwt") => ({ alg: "ES256", typ, kid });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function pair(kid: string): Promise<{ privateKey: CryptoKey; key: SnapshotKey }> {
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  return {
    privateKey: generated.privateKey,
    key: { kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid, x: jwk.x as string, y: jwk.y as string },
  };
}

const signer = await pair("vec-1");
const stranger = await pair("vec-2");

async function sign(claims: Claims, head = header("vec-1"), privateKey = signer.privateKey): Promise<string> {
  const signed = `${encode(head)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}

const at = (seconds: number) => new Date(seconds * 1000).toISOString();
const withEntitlements = (...entitlements: unknown[]) => ({ ...base, entitlements });

const cases: { name: string; token: Promise<string>; now?: number; clockSkewSeconds?: number }[] = [
  { name: "plan, default plan and grant sources with a meter", token: sign(withEntitlements(exportPdf, aiCredits)) },
  { name: "an add-on source through a group", token: sign(withEntitlements(addOns)) },
  { name: "a money feature's limits by market", token: sign(withEntitlements(spend)) },
  { name: "a group and its member, skipping an unknown source", token: sign(withEntitlements(group, member)) },
  { name: "a metered feature with no meter", token: sign(withEntitlements(noMeter)) },
  { name: "signed within the clock skew", token: sign(withEntitlements(exportPdf)), now: ISSUED - 60 },
  { name: "signed beyond the clock skew", token: sign(withEntitlements(exportPdf)), now: ISSUED - 61 },
  {
    name: "signed beyond a narrower clock skew",
    token: sign(withEntitlements(exportPdf)),
    now: ISSUED - 30,
    clockSkewSeconds: 10,
  },
  { name: "the last second before expiry", token: sign(withEntitlements(exportPdf)), now: EXPIRES - 1 },
  { name: "expired", token: sign(withEntitlements(exportPdf)), now: EXPIRES },
  {
    name: "a key that is not in the set",
    token: sign(withEntitlements(exportPdf), header("vec-2"), stranger.privateKey),
  },
  {
    name: "a known kid with another key's signature",
    token: sign(withEntitlements(exportPdf), header("vec-1"), stranger.privateKey),
  },
  {
    name: "edited claims",
    token: sign(withEntitlements(exportPdf)).then((token) => {
      const [head, , signature] = token.split(".");
      return `${head}.${encode({ ...withEntitlements(exportPdf), sub: "user_2" })}.${signature}`;
    }),
  },
  { name: "another type", token: sign(withEntitlements(exportPdf), header("vec-1", "JWT")) },
  { name: "another issuer", token: sign({ ...withEntitlements(exportPdf), iss: "someone" }) },
  { name: "another customer", token: sign({ ...withEntitlements(exportPdf), sub: "user_2" }) },
  { name: "another environment", token: sign({ ...withEntitlements(exportPdf), environment: { id: "en_2" } }) },
];

const keys = { keys: [signer.key] };
const vectors = [];
for (const given of cases) {
  const token = await given.token;
  const now = given.now ?? ISSUED + 1;
  const expected = {
    customer: CUSTOMER,
    environment: ENVIRONMENT,
    now: at(now),
    ...(given.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: given.clockSkewSeconds }),
  };
  const outcome = await verifySnapshot(token, { ...expected, keys, now: new Date(now * 1000) }).then(
    ({ customer, environment, issuedAt, expiresAt, entitlements }) => ({
      snapshot: JSON.parse(
        JSON.stringify({
          customer,
          environment,
          issuedAt,
          expiresAt,
          served: entitlements.served,
          entitlements: entitlements.entitlements,
        }),
      ),
    }),
    (error: unknown) => {
      if (!(error instanceof SnapshotError)) throw error;
      return { error: error.reason };
    },
  );
  vectors.push({ name: given.name, token, expected, outcome });
}

writeFileSync(OUT, `${JSON.stringify({ keys, vectors }, null, 2)}\n`);
console.log(`Wrote ${vectors.length} vectors.`);
