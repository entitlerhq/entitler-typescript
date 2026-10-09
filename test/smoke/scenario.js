import { defineFeature, EntitlerClient, EntitlerServer, verifySnapshot } from "../../dist/index.js";

const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const part = (value) => encode(new TextEncoder().encode(JSON.stringify(value)));

export async function scenario() {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
      cache: init.cache,
      redirect: init.redirect,
    });
    return new Response(
      JSON.stringify({
        customer: "user_1",
        environment: { id: "env_1", name: "development", kind: "test" },
        track: { id: "t", name: "All customers" },
        release: 2,
        change: null,
        testers: true,
        experiment: null,
        asOf: "2026-10-09T00:00:00.000Z",
        feature: "export_pdf",
        type: "boolean",
        entitled: true,
        value: true,
        sources: [],
        upgrades: [],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", etag: '"1"', "cache-control": "private, no-cache" },
      },
    );
  };
  const token = `${part({ alg: "none" })}.${part({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
  const client = new EntitlerClient({ token: async () => token, fetch });
  const check = await client.me.check(defineFeature("export_pdf", "boolean"));
  const server = new EntitlerServer({ key: "ent_test_smoke", fetch, cache: false });
  await server.customer("user_1").isEntitled("export_pdf", { default: false });

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const header = part({ alg: "ES256", typ: "entitlements+jwt", kid: "k1" });
  const payload = part({
    iss: "https://api.entitler.dev/customers",
    sub: "user_1",
    environment: { id: "env_1" },
    track: { id: "t", name: "All customers" },
    release: 2,
    change: null,
    testers: true,
    entitlements: [{ key: "export_pdf", type: "boolean", entitled: true, value: true, sources: [] }],
    iat: now,
    exp: now + 600,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  const snapshot = await verifySnapshot(`${header}.${payload}.${encode(signature)}`, {
    keys: [{ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid: "k1", alg: "ES256", use: "sig" }],
    customer: "user_1",
    environment: "env_1",
  });
  return {
    entitled: check.entitled,
    meId: client.me.id,
    visitor: client.visitor,
    snapshot: snapshot.entitlements.has("export_pdf"),
    requests: seen,
  };
}
