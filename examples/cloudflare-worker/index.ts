import { defineFeature, EntitlerServer, MemoryCache } from "@entitlerhq/entitler";

interface Env {
  ENTITLER_KEY: string;
  SESSION_SECRET: string;
}

const exportPdf = defineFeature("export_pdf", "boolean");
const cache = new MemoryCache({ maxEntries: 500 });
const encoder = new TextEncoder();
let server: EntitlerServer | undefined;

function entitler(env: Env): EntitlerServer {
  server ??= new EntitlerServer({ key: env.ENTITLER_KEY, cache, onError: (error) => console.warn(error) });
  return server;
}

function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sessionCookie(userId: string, secret: string): Promise<string> {
  const encoded = encodeURIComponent(userId);
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret), encoder.encode(encoded));
  return `session=${encoded}.${hex(signature)}`;
}

async function signedInUserId(request: Request, env: Env): Promise<string | undefined> {
  const session = /(?:^|;\s*)session=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const dot = session?.lastIndexOf(".") ?? -1;
  if (!session || dot < 1 || !env.SESSION_SECRET) return undefined;
  const encoded = session.slice(0, dot);
  const signature = session.slice(dot + 1);
  if (!/^(?:[0-9a-f]{2})+$/.test(signature)) return undefined;
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = await sessionKey(env.SESSION_SECRET);
  return (await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(encoded)))
    ? decodeURIComponent(encoded)
    : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const customerId = await signedInUserId(request, env);
    if (!customerId) return new Response("Sign in first.", { status: 401 });
    const customer = entitler(env).customer(customerId);
    if (!(await customer.isEntitled(exportPdf, { default: false, signal: request.signal }))) {
      return Response.json({ error: "Upgrade to export PDFs." }, { status: 402 });
    }
    return new Response("%PDF-1.7 …", { headers: { "content-type": "application/pdf" } });
  },
};
