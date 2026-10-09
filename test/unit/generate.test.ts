import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/command.js";
import { constantNames, type FeatureSource, renderFeatures, sameFeatures } from "../../src/generate.js";
import { apiError, fakeFetch, json } from "./fake.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const feature = (key: string, overrides: Partial<FeatureSource["features"][number]> = {}) => ({
  key,
  name: key,
  type: "boolean",
  description: "",
  unit: "",
  archived: false,
  includes: [] as string[],
  ...overrides,
});

const catalogue: FeatureSource = {
  environment: { name: "development" },
  track: { name: "All customers" },
  release: 2,
  change: null,
  features: [
    feature("team_seats", { name: "Team seats", type: "config", unit: "seats" }),
    feature("export_pdf", {
      name: "Export to PDF",
      description: "Download any document as a PDF.\nKeeps */ comments safe.",
    }),
    feature("ai_credits", {
      name: "AI credits",
      type: "metered",
      description: "Spent on AI actions each month.",
      unit: "credits",
    }),
    feature("collaboration", { name: "Collaboration", type: "group", includes: ["team_seats", "shared_folders"] }),
    feature("shared_folders", { name: "" }),
    feature("team_essentials", {
      name: "Team essentials",
      type: "group",
      includes: ["collaboration", "support_extras", "team_seats", "unknown_key"],
    }),
    feature("support_extras", {
      name: "Support extras",
      type: "group",
      includes: ["priority_support", "team_essentials"],
    }),
    feature("priority_support", { name: "Priority support", archived: true }),
  ],
};

async function golden(name: string, content: string) {
  const file = new URL(`../fixtures/generate/${name}`, import.meta.url);
  if (process.env.UPDATE_GOLDEN) await writeFile(file, content);
  expect(content).toBe(await readFile(file, "utf8"));
}

function formatted(source: string): string {
  return execFileSync(
    process.execPath,
    [
      join(process.cwd(), "node_modules/@biomejs/biome/bin/biome"),
      "format",
      "--stdin-file-path=features.ts",
      "--line-width=80",
      "--indent-style=space",
    ],
    { input: source, encoding: "utf8" },
  );
}

describe("renderFeatures", () => {
  it("renders the catalogue", async () => {
    await golden("catalogue.ts", renderFeatures(catalogue));
  });

  it("is formatted as the formatter would leave it", () => {
    const source = renderFeatures({
      ...catalogue,
      features: [
        ...catalogue.features,
        feature("a_group_with_a_very_long_key_name_that_overflows", {
          type: "group",
          includes: ["export_pdf", "team_seats", "shared_folders", "ai_credits"],
        }),
        feature("an_extremely_long_feature_key_that_makes_even_the_opening_line_overflow_the_width", {
          type: "group",
          includes: ["export_pdf"],
        }),
        feature("another_extremely_long_feature_key_that_overflows_the_line_width_alone"),
        feature("a_feature_key_whose_name_and_call_overflow_together_x"),
        feature("an_extremely_long_key_that_needs_its_own_line_and_more", { type: "group", includes: ["export_pdf"] }),
        feature("one_more_extremely_long_feature_key_with_many_members_to_list_out", {
          type: "group",
          includes: ["export_pdf", "team_seats", "shared_folders", "ai_credits", "collaboration"],
        }),
      ],
    });
    expect(source).toBe(formatted(source));
  });

  it("renders an empty catalogue", async () => {
    const source = renderFeatures({ ...catalogue, features: [] });
    await golden("empty.ts", source);
    expect(source).toBe(formatted(source));
  });

  it("names the change a track follows", () => {
    expect(renderFeatures({ ...catalogue, release: null, change: "chg_7" })).toContain(
      "// Read from development, All customers, change chg_7.",
    );
    expect(renderFeatures({ ...catalogue, release: null, change: null })).toContain("release none.");
  });

  it("escapes names deterministically", async () => {
    const source = renderFeatures({
      ...catalogue,
      features: ["2fa", "delete", "export-pdf", "export_pdf", "exportPdf", "__", "class", "new_", "a.b"].map((key) =>
        feature(key),
      ),
    });
    await golden("escaping.ts", source);
  });

  it("keeps the names an existing file gave", async () => {
    const existing = renderFeatures({ ...catalogue, features: [feature("export_pdf"), feature("sso")] }).replace(
      "exportPdf:",
      "pdfExport:",
    );
    const source = renderFeatures(
      { ...catalogue, features: [feature("export_pdf"), feature("pdf_export"), feature("sso"), feature("audit_log")] },
      { existing },
    );
    await golden("kept.ts", source);
    expect(source).toContain('  pdfExport: defineFeature("export_pdf", "boolean"),');
    expect(source).toContain('  pdfExport2: defineFeature("pdf_export", "boolean"),');
  });

  it("drops kept names for features no longer listed and ignores duplicates", () => {
    const existing =
      '  old: defineFeature("gone", "boolean"),\n  a: defineFeature("x", "boolean"),\n  a: defineFeature("y", "boolean"),\n';
    const names = constantNames(["x", "y"], existing);
    expect([...names]).toEqual([
      ["x", "a"],
      ["y", "y"],
    ]);
  });

  it("compares files ignoring the Read from line", () => {
    const a = renderFeatures(catalogue);
    const b = renderFeatures({ ...catalogue, release: 3 });
    expect(a).not.toBe(b);
    expect(sameFeatures(a, b)).toBe(true);
    expect(sameFeatures(a, renderFeatures({ ...catalogue, features: [] }))).toBe(false);
  });
});

describe("entitler generate", () => {
  const listing = {
    environment: { id: "e", name: "development", kind: "test" },
    track: { id: "t", name: "All customers" },
    release: 2,
    change: null,
    features: [
      {
        id: "1",
        key: "sso",
        name: "SSO",
        type: "boolean",
        description: "",
        unit: "",
        resetEvery: null,
        archived: false,
        includes: [],
      },
    ],
  };

  async function run(args: string[], env: Record<string, string | undefined> = { ENTITLER_KEY: "ent_test_k" }) {
    let stdout = "";
    let stderr = "";
    const code = await main(
      args,
      env,
      (text) => (stdout += text),
      (text) => (stderr += text),
    );
    return { code, stdout, stderr };
  }

  async function temp() {
    return join(await mkdtemp(join(tmpdir(), "entitler-")), "src", "entitler.gen.ts");
  }

  it("prints usage for --help and exits 0", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: entitler generate [options]");
    expect((await run(["generate", "--help"])).code).toBe(0);
  });

  it("prints usage with no command and exits 1", async () => {
    const result = await run([]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("Usage: entitler generate");
    expect((await run(["make"])).stderr).toContain("Unknown command make.");
  });

  it("refuses unknown options and missing values", async () => {
    expect((await run(["generate", "--force"])).stderr).toContain("Unknown option --force.");
    expect(await run(["generate", "--out"])).toMatchObject({ code: 1, stderr: "Pass a value with --out.\n" });
    expect(await run(["generate", "--out="])).toMatchObject({ code: 1 });
    expect((await run(["generate", "--check=yes"])).code).toBe(1);
  });

  it("asks for a key", async () => {
    expect(await run(["generate"], {})).toEqual({
      code: 1,
      stdout: "",
      stderr: "Provide an API key with --key or set ENTITLER_KEY. The key needs the plans:read scope.\n",
    });
  });

  it("writes the file, then finds it up to date", async () => {
    const { fetch: fake, sent } = fakeFetch(json(listing));
    vi.stubGlobal("fetch", fake);
    const file = await temp();
    expect(await run(["generate", "--out", file, "--key=ent_test_flag", "--base-url", "http://localhost:9"])).toEqual({
      code: 0,
      stdout: `Wrote 1 feature to ${file}.\n`,
      stderr: "",
    });
    expect(sent[0]?.url).toBe("http://localhost:9/pricing/features");
    expect(sent[0]?.headers.authorization).toBe("Bearer ent_test_flag");
    expect(await readFile(file, "utf8")).toContain('sso: defineFeature("sso", "boolean")');
    expect(await run(["generate", `--out=${file}`, "--check"])).toEqual({
      code: 0,
      stdout: `${file} is up to date with 1 feature.\n`,
      stderr: "",
    });
  });

  it("finds a missing or changed file out of date", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch(json({ ...listing, features: [...listing.features, { ...listing.features[0], key: "audit" }] })).fetch,
    );
    const file = await temp();
    expect(await run(["generate", "--out", file, "--check"])).toEqual({
      code: 1,
      stdout: "",
      stderr: `${file} is out of date. Run entitler generate to update it.\n`,
    });
    expect((await run(["generate", "--out", file])).stdout).toBe(`Wrote 2 features to ${file}.\n`);
  });

  it("reports API failures with their code", async () => {
    vi.stubGlobal("fetch", fakeFetch(apiError(403, "scope_required", "This key lacks plans:read.")).fetch);
    expect(await run(["generate", "--out", await temp()])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Entitler request failed: This key lacks plans:read (scope_required).\n",
    });
  });

  it("reports connection failures", async () => {
    vi.stubGlobal("fetch", fakeFetch(new TypeError("offline")).fetch);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect((await run(["generate", "--out", await temp()])).stderr).toBe(
      "Entitler request failed: Entitler could not be reached (connection_failed).\n",
    );
  });

  it("rethrows unexpected file errors", async () => {
    vi.stubGlobal("fetch", fakeFetch(json(listing)).fetch);
    await expect(run(["generate", "--out", tmpdir()])).rejects.toThrow();
  });
});
