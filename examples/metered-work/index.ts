import { defineFeature, EntitlerServer, UsageRefusedError } from "@entitlerhq/entitler";

const aiCredits = defineFeature("ai_credits", "metered");
const entitler = new EntitlerServer({ key: process.env.ENTITLER_SECRET_KEY ?? "" });

async function* complete(prompt: string, signal: AbortSignal): AsyncGenerator<{ text: string; tokens: number }> {
  signal.throwIfAborted();
  yield { text: `Echo: ${prompt}`, tokens: prompt.length };
}

export async function answer(userId: string, messageId: string, prompt: string): Promise<string> {
  try {
    return await entitler.customer(userId).withHold(
      aiCredits,
      2_000,
      async ({ hold, signal }) => {
        let text = "";
        let tokens = 0;
        for await (const chunk of complete(prompt, signal)) {
          text += chunk.text;
          tokens += chunk.tokens;
          hold.use(tokens);
        }
        return text;
      },
      { idempotencyKey: messageId },
    );
  } catch (error) {
    if (error instanceof UsageRefusedError) return "You're out of AI credits this month.";
    throw error;
  }
}
