import { defineFeature, EntitlerServer, MemoryCache } from "@entitlerhq/entitler";

interface Env {
  ENTITLER_KEY: string;
}

const exportPdf = defineFeature("export_pdf", "boolean");
const cache = new MemoryCache({ maxEntries: 500 });
let server: EntitlerServer | undefined;

function entitler(env: Env): EntitlerServer {
  server ??= new EntitlerServer({ key: env.ENTITLER_KEY, cache, onError: (error) => console.warn(error) });
  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const customerId = request.headers.get("x-user-id");
    if (!customerId) return new Response("Sign in first.", { status: 401 });
    const customer = entitler(env).customer(customerId);
    if (!(await customer.isEntitled(exportPdf, { default: false, signal: request.signal }))) {
      return Response.json({ error: "Upgrade to export PDFs." }, { status: 402 });
    }
    return new Response("%PDF-1.7 …", { headers: { "content-type": "application/pdf" } });
  },
};
