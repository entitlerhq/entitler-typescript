import { defineFeature, EntitlerServer } from "@entitlerhq/entitler";

const exportPdf = defineFeature("export_pdf", "switch");
const aiCredits = defineFeature("ai_credits", "metered");

const entitler = new EntitlerServer({ key: process.env.ENTITLER_SECRET_KEY ?? "" });
const customer = entitler.customer("user_123");

await customer.register({ name: "Ada Lovelace", email: "ada@example.com" });

if (await customer.isEntitled(exportPdf, { default: false })) {
  console.log("Exporting the PDF.");
}

const result = await customer.recordUsage(aiCredits, 3, { idempotencyKey: "job_42" });
if (result.outcome === "refused") console.log("Out of AI credits:", result.upgrades);

entitler.close();
