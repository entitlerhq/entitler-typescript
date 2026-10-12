import { defineFeature, EntitlerServer, UsageRefusedError, UsageReplayedError } from "@entitlerhq/entitler";

const aiCredits = defineFeature("ai_credits", "metered");
const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? `metered-${Date.now()}`);
await customer.register();
const run = Date.now();

async function* tokens(): AsyncIterable<number> {
  for (const total of [2, 5, 8]) yield total;
}

async function streamAnswer(messageId: string): Promise<string> {
  let hold: Awaited<ReturnType<typeof customer.startHold>>;
  try {
    hold = await customer.startHold(aiCredits, 10, { idempotencyKey: messageId });
  } catch (error) {
    if (error instanceof UsageRefusedError) return "Not enough credits: upgrade to continue.";
    if (error instanceof UsageReplayedError) return "This message was already answered.";
    throw error;
  }
  try {
    hold.use(0);
    for await (const total of tokens()) hold.use(total);
    return "Streamed the answer.";
  } finally {
    const settled = await hold.finish();
    console.log(`Charged ${settled.amount} credits for the stream.`);
  }
}

console.log(await streamAnswer(`message-${run}`));

async function summarise(signal: AbortSignal): Promise<{ text: string; credits: number }> {
  signal.throwIfAborted();
  return { text: "A short summary.", credits: 3 };
}

try {
  const summary = await customer.withHold(
    aiCredits,
    5,
    async ({ hold, signal }) => {
      const result = await summarise(signal);
      hold.use(result.credits);
      return result;
    },
    { idempotencyKey: `summary-${run}` },
  );
  console.log(`${summary.text} (${summary.credits} credits)`);
} catch (error) {
  if (error instanceof UsageRefusedError) console.log(`Not enough credits: ${error.result.refusal}.`);
  else if (error instanceof UsageReplayedError) console.log("This summary was already made.");
  else throw error;
}

const observed = await customer.recordUsage(aiCredits, 2, { mode: "observe", idempotencyKey: `upload-${run}` });
console.log(`Observed ${observed.amount} more; over the allowance by ${observed.overBy}.`);
if (!process.env.CUSTOMER_ID) await customer.erase();
server.close();
