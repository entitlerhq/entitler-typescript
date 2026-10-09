import { defineFeature, EntitlerServer, UsageRefusedError } from "@entitlerhq/entitler";

const aiCredits = defineFeature("ai_credits", "metered");
const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? "metered-user");
await customer.register();

async function summarise(signal: AbortSignal): Promise<{ text: string; credits: number }> {
  signal.throwIfAborted();
  return { text: "A short summary.", credits: 3 };
}

const jobId = `summary-${Date.now()}`;
try {
  const summary = await customer.withHold(
    aiCredits,
    10,
    async ({ hold, signal }) => {
      const result = await summarise(signal);
      hold.use(result.credits);
      return result;
    },
    { idempotencyKey: jobId },
  );
  console.log(`${summary.text} (${summary.credits} credits)`);
} catch (error) {
  if (!(error instanceof UsageRefusedError)) throw error;
  console.log(`Not enough credits: ${error.result.refusal ?? error.result.outcome}.`);
}

const streamed = await customer.recordUsage(aiCredits, 2, { mode: "observe", idempotencyKey: `${jobId}-stream` });
console.log(`Observed ${streamed.amount} more; over the allowance by ${streamed.overBy}.`);
