import { defineFeature, EntitlerServer, SnapshotError, verifySnapshot } from "@entitlerhq/entitler";

const exportPdf = defineFeature("export_pdf", "boolean");
const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? "test_1001");

const keys = await server.snapshotKeys();
const snapshot = await customer.snapshot();
const environment = (await customer.check(exportPdf)).environment.id;

try {
  const verified = await verifySnapshot(snapshot.token, { keys, customer: customer.id, environment });
  console.log(`Snapshot valid until ${verified.expiresAt.toISOString()}.`);
  console.log(`Export to PDF: ${verified.entitlements.has(exportPdf) ? "on" : "off"}.`);
} catch (error) {
  if (!(error instanceof SnapshotError)) throw error;
  console.log(`${error.code}: ${error.message}`);
}
