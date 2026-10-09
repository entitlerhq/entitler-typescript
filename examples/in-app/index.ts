import { defineFeature, EntitlerClient, EntitlerServer } from "@entitlerhq/entitler";

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  exportPdf: defineFeature("export_pdf", "boolean"),
};

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const signedIn = server.customer(process.env.CUSTOMER_ID ?? "in-app-user");
await signedIn.register();

const client = new EntitlerClient({
  token: async () => (await signedIn.token({ scopes: ["entitlements:read", "usage:write"], ttlSeconds: 900 })).token,
});

const pdf = await client.me.check(features.exportPdf);
console.log(`${client.me.id} ${pdf.entitled ? "may" : "may not"} export PDFs.`);

const usage = await client.me.recordUsage(features.aiCredits, 1, { idempotencyKey: `in-app-${Date.now()}` });
console.log(`Recorded usage: ${usage.outcome}.`);

client.close();
console.log("Signed out: the client is closed, and the next sign-in creates a new one.");
server.close();
