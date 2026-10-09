import type { EntitlerServer, ServerCustomer, SnapshotKeys } from "@entitlerhq/entitler";

declare global {
  const server: EntitlerServer;
  const customer: ServerCustomer;
  const job: { id: string; finishedAt: string };
  const run: (options: { signal: AbortSignal }) => Promise<{ tokens: number }>;
  const streamModel: (options: { signal: AbortSignal }) => AsyncIterable<{ tokens: number }>;
  const session: { userId: string };
  const auth: { currentUser: { getIdToken(): Promise<string> } };
  const cookies: { get(name: string): string | undefined };
  const shippedKeys: SnapshotKeys;
  const visitor: string;
  const features: typeof import("./out/entitler.gen.js").features;
}
