import { Miniflare } from "miniflare";

const bundle = await Bun.build({ entrypoints: ["test/smoke/worker.js"], target: "browser", format: "esm" });
if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the Workers smoke check.");
const script = await (bundle.outputs[0] as Blob).text();

for (const compatibilityDate of ["2024-09-23", "2026-07-01"]) {
  const worker = new Miniflare({ modules: true, script, compatibilityDate });
  try {
    const response = await worker.dispatchFetch("https://smoke.test/");
    const result = (await response.json()) as {
      entitled?: boolean;
      snapshot?: boolean;
      error?: string;
      requests?: { headers: Record<string, string>; cache?: string }[];
    };
    const failures = [
      result.error,
      result.entitled !== true && "the check did not answer entitled",
      result.snapshot !== true && "the snapshot did not verify",
      result.requests?.some((request) => request.headers["user-agent"]?.startsWith("entitler-typescript/") !== true) &&
        "a request did not name the SDK in User-Agent",
      result.requests?.some((request) => !request.headers["user-agent"]?.endsWith(" workerd")) &&
        "a request did not name workerd",
    ].filter(Boolean);
    if (failures.length) throw new Error(`Workers smoke check failed on ${compatibilityDate}: ${failures.join("; ")}.`);
    console.log(`Workers smoke check passed on compatibility date ${compatibilityDate}.`);
  } finally {
    await worker.dispose();
  }
}
