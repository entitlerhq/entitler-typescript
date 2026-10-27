import { SnapshotError, type SnapshotKeySet, verifySnapshot } from "@entitlerhq/entitler";

declare const keys: SnapshotKeySet;
declare const session: { userId: string };
declare const storage: { get(key: string): Promise<string | null> };

const ENVIRONMENT_ID = "en_live";

async function canExportOffline(): Promise<boolean> {
  const saved = await storage.get("entitler-snapshot");
  if (saved === null) return false;
  try {
    const snapshot = await verifySnapshot(saved, { keys, customer: session.userId, environment: ENVIRONMENT_ID });
    return snapshot.entitlements.has("export_pdf");
  } catch (error) {
    if (error instanceof SnapshotError) return false;
    throw error;
  }
}

console.log("Export allowed offline:", await canExportOffline());
