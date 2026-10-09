import assert from "node:assert/strict";
import { type Customer, defineFeature } from "@entitlerhq/entitler";
import { fakeCustomer } from "@entitlerhq/entitler/testing";

const features = {
  aiCredits: defineFeature("ai_credits", "metered"),
  exportPdf: defineFeature("export_pdf", "boolean"),
};

async function exportReport(customer: Customer, requestId: string): Promise<string> {
  if (!(await customer.isEntitled(features.exportPdf, { default: false }))) return "upgrade";
  const charge = await customer.recordUsage(features.aiCredits, 5, { idempotencyKey: `export-${requestId}` });
  return charge.outcome === "refused" ? "out of credits" : "exported";
}

async function upgrade(customer: Customer): Promise<string> {
  const step = await customer.subscribe("pro", { period: "monthly", returnUrl: "https://example.com/back" });
  return step.next === "pay" ? step.url : step.next;
}

const plenty = fakeCustomer({ export_pdf: true, ai_credits: { value: 100, used: 10 } });
assert.equal(await exportReport(plenty, "r1"), "exported");
assert.equal(await exportReport(plenty, "r1"), "exported");
assert.equal((await plenty.check(features.aiCredits)).used, 15);

const nearlyOut = fakeCustomer({ export_pdf: true, ai_credits: { value: 100, used: 97 } });
assert.equal(await exportReport(nearlyOut, "r2"), "out of credits");

const free = fakeCustomer({ ai_credits: { value: 20 } });
assert.equal(await exportReport(free, "r3"), "upgrade");

assert.equal(await upgrade(free), "done");
free.answer("subscribe", () => ({ next: "pay", url: "https://checkout.stripe.com/c/test" }));
assert.equal(await upgrade(free), "https://checkout.stripe.com/c/test");
assert.deepEqual(
  free.writes.map((write) => write.method),
  ["subscribe", "subscribe"],
);

console.log("The app's gating and billing code passed its tests.");
