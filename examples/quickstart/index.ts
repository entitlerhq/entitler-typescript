import { defineFeature, EntitlerServer } from "@entitlerhq/entitler";

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  exportPdf: defineFeature("export_pdf", "boolean"),
};

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? "quickstart-user");

await customer.register({ name: "Ada Lovelace", email: "ada@example.com" });

if (await customer.isEntitled(features.exportPdf, { default: false })) {
  console.log("Exporting the PDF.");
} else {
  console.log("Export to PDF needs an upgrade.");
}

const usage = await customer.recordUsage(features.aiCredits, 1, { idempotencyKey: `quickstart-${Date.now()}` });
console.log(`Recorded usage: ${usage.outcome}, ${usage.remaining ?? "no"} credits left.`);
