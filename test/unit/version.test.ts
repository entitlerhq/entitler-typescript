import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { VERSION } from "../../src/index.js";

it("matches the package version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
