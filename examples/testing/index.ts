import { defineFeature, type ServerCustomer, UsageRefusedError } from "@entitlerhq/entitler";
import { fakeCustomer } from "@entitlerhq/entitler/testing";

const aiCredits = defineFeature("ai_credits", "metered");

async function summarise(customer: ServerCustomer, jobId: string): Promise<string> {
  try {
    await customer.recordUsage(aiCredits, 25, { idempotencyKey: jobId });
    return "summarised";
  } catch (error) {
    if (error instanceof UsageRefusedError) return "refused";
    throw error;
  }
}

const customer = fakeCustomer({ ai_credits: { value: 100, used: 90 } });
const result = await customer.recordUsage(aiCredits, 25, { idempotencyKey: "job-1" });
console.assert(result.outcome === "refused", "a gated report past the allowance is refused");
console.assert((await summarise(customer, "job-2")) === "summarised");
console.assert(customer.writes.length === 2);
