import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { ApiError, TimeoutError } from "./errors.js";
import { renderFeatures, sameFeatures } from "./generate.js";
import { EntitlerServer } from "./server.js";

const USAGE = `Usage: npx @entitlerhq/entitler generate [options]

Writes a TypeScript file of typed feature constants from your Entitler catalogue.

Options:
  --out <file>       The file to write. Defaults to src/entitler.gen.ts.
  --key <key>        An API key with the plans:read scope. Defaults to ENTITLER_KEY.
  --base-url <url>   The API's base URL. Defaults to https://api.entitler.dev.
  --check            Check the file is up to date instead of writing it.
  --help             Show this help.
`;

const VALUED = new Set(["--out", "--key", "--base-url"]);

function features(n: number): string {
  return n === 1 ? "1 feature" : `${n} features`;
}

async function readExisting(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Runs the command line with `args` (without the program name), answering the exit code. @internal */
export async function main(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  out: (text: string) => void = (text) => process.stdout.write(text),
  err: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  if (args.includes("--help")) {
    out(USAGE);
    return 0;
  }
  const [command, ...rest] = args;
  if (command !== "generate") {
    err(command === undefined ? USAGE : `Unknown command ${command}.\n\n${USAGE}`);
    return 1;
  }
  const options: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg];
    if (flag === "--check" && inline === undefined) {
      options.check = true;
    } else if (VALUED.has(flag as string)) {
      if (inline === undefined) i += 1;
      const value = inline ?? rest[i];
      if (value === undefined || value === "") {
        err(`Pass a value with ${flag}.\n`);
        return 1;
      }
      options[(flag as string).slice(2)] = value;
    } else {
      err(`Unknown option ${arg}.\n\n${USAGE}`);
      return 1;
    }
  }
  const file = (options.out as string | undefined) ?? "src/entitler.gen.ts";
  const key = (options.key as string | undefined) ?? env.ENTITLER_KEY;
  if (!key?.trim()) {
    err("Provide an API key with --key or set ENTITLER_KEY. The key needs the plans:read scope.\n");
    return 1;
  }
  let source: Awaited<ReturnType<EntitlerServer["features"]>>;
  try {
    const baseUrl = options["base-url"] as string | undefined;
    source = await new EntitlerServer({ key, cache: false, ...(baseUrl ? { baseUrl } : {}) }).features();
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
    const code =
      error instanceof ApiError ? error.code : error instanceof TimeoutError ? "timed_out" : "connection_failed";
    err(`Entitler request failed: ${message} (${code}).\n`);
    return 1;
  }
  const existing = await readExisting(file);
  const rendered = renderFeatures(source, existing === undefined ? {} : { existing });
  const count = features(source.features.length);
  if (options.check) {
    if (existing !== undefined && sameFeatures(existing, rendered)) {
      out(`${file} is up to date with ${count}.\n`);
      return 0;
    }
    err(`${file} is out of date. Run entitler generate to update it.\n`);
    return 1;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rendered);
  out(`Wrote ${count} to ${file}.\n`);
  return 0;
}
