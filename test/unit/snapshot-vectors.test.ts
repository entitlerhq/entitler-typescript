import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SnapshotError, type SnapshotKeySet, verifySnapshot } from "../../src/index.js";

interface Vector {
  name: string;
  token: string;
  expected: { customer: string; environment: string; now: string; clockSkewSeconds?: number };
  outcome: { snapshot: unknown } | { error: string };
}

const { keys, vectors } = JSON.parse(
  readFileSync(new URL("../fixtures/snapshot-vectors.json", import.meta.url), "utf8"),
) as { keys: SnapshotKeySet; vectors: Vector[] };

describe("the shared snapshot vectors", () => {
  it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", async (_, vector) => {
    const outcome = await verifySnapshot(vector.token, {
      ...vector.expected,
      keys,
      now: new Date(vector.expected.now),
    }).then(
      ({ customer, environment, issuedAt, expiresAt, entitlements }) => ({
        snapshot: JSON.parse(
          JSON.stringify({
            customer,
            environment,
            issuedAt,
            expiresAt,
            served: entitlements.served,
            entitlements: entitlements.entitlements,
          }),
        ),
      }),
      (error: unknown) => {
        if (!(error instanceof SnapshotError)) throw error;
        return { error: error.reason };
      },
    );
    expect(outcome).toEqual(vector.outcome);
  });
});
