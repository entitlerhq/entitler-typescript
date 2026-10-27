import assert from "node:assert/strict";
import { defineFeature, type ServerCustomer } from "@entitlerhq/entitler";
import { fakeCustomer } from "@entitlerhq/entitler/testing";

const aiCredits = defineFeature("ai_credits", "metered");

async function summarise(customer: ServerCustomer, jobId: string): Promise<string> {
  const result = await customer.recordUsage(aiCredits, 25, { idempotencyKey: jobId });
  return result.outcome === "refused" ? "refused" : "summarised";
}

const customer = fakeCustomer({ ai_credits: { value: 100, used: 70 } });
assert.equal(await summarise(customer, "job-1"), "summarised");
assert.equal(await summarise(customer, "job-2"), "refused");
assert.equal(customer.writes.length, 2);
