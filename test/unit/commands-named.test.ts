import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

function filesUnder(directory: string, skip: readonly string[] = []): string[] {
  return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .filter((path) => !skip.some((skipped) => path.startsWith(skipped)));
}

const sources = ["README.md", ...filesUnder("src"), ...filesUnder("docs", ["docs/api"]), ...filesUnder("examples")];

describe("generator commands", () => {
  it("name the command as users run it, from the scoped package", () => {
    const unscoped = sources.flatMap((path) =>
      readFileSync(join(root, path), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /\b(?:npx|bunx) entitler\b|(?<![@/\w-])entitler (?:generate|snapshot-keys)\b/.test(line)
            ? [`${path}:${index + 1}`]
            : [],
        ),
    );
    expect(unscoped).toEqual([]);
  });
});
