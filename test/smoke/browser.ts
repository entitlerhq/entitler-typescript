import { chromium } from "playwright-core";

const bundle = await Bun.build({
  entrypoints: ["test/smoke/scenario.js"],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the browser smoke check.");
const code = await (bundle.outputs[0] as Blob).text();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage();
  await page.route("https://smoke.test/**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/html",
      body: route.request().url().endsWith(".js") ? code : "<!doctype html><title>Smoke</title>",
    }),
  );
  await page.goto("https://smoke.test/");
  const result = await page.evaluate(async () => {
    const module = await import("https://smoke.test/scenario.js");
    const answer = await module.scenario();
    return { ...answer, stored: localStorage.getItem("entitler.visitor") };
  });
  const failures = [
    result.entitled !== true && "the check did not answer entitled",
    result.meId !== "user_1" && "me.id was not read from the answer",
    result.snapshot !== true && "the snapshot did not verify",
    result.stored !== result.visitor && "the visitor was not kept in localStorage",
    result.requests.some((request: { cache?: string }) => request.cache !== "no-store") &&
      "a request used the HTTP cache",
    result.requests.some((request: { redirect?: string }) => request.redirect !== "manual") &&
      "a request follows redirects",
    result.requests.some((request: { headers: Record<string, string> }) => "user-agent" in request.headers) &&
      "a request set User-Agent in a browser",
  ].filter(Boolean);
  if (failures.length) throw new Error(`Browser smoke check failed: ${failures.join("; ")}.`);
  console.log(`Browser smoke check passed in ${browser.version()}.`);
} finally {
  await browser.close();
}
