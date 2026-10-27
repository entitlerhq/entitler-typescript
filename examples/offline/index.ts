import { type SnapshotKeySet, verifySnapshot } from "@entitlerhq/entitler";

declare const keys: SnapshotKeySet;
declare const session: { userId: string };
declare const storage: { get(key: string): Promise<string | null> };

const ENVIRONMENT_ID = "en_live";

const saved = await storage.get("entitler-snapshot");
if (saved !== null) {
  const snapshot = await verifySnapshot(saved, { keys, customer: session.userId, environment: ENVIRONMENT_ID });
  console.log("Export allowed offline:", snapshot.entitlements.has("export_pdf"));
}
