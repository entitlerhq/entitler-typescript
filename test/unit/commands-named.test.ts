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

describe("the README", () => {
  it("links every guide, every example and the licence by absolute GitHub URL", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const base = "https://github.com/entitlerhq/entitler-typescript/blob/main/";
    const relative = [...readme.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1] as string)
      .filter((link) => !/^(?:https?:|#|mailto:)/.test(link));
    expect(relative).toEqual([]);
    const guides = filesUnder("docs", ["docs/api"]).filter((path) => path.endsWith(".md"));
    const examples = readdirSync(join(root, "examples"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `examples/${entry.name}/`);
    for (const path of [...guides, "LICENSE"]) expect(readme, path).toContain(`](${base}${path})`);
    for (const path of examples) expect(readme, path).toContain(`](${base}${path}`);
  });
});
