import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { ApiError, TimeoutError } from "./errors.js";
import { holdsConstants, renderFeatures, sameFeatures } from "./generate.js";
import { EntitlerServer } from "./server.js";

const USAGE = `Usage: npx @entitlerhq/entitler <command> [options]

Commands:
  generate        Writes a TypeScript file of typed feature constants from your Entitler catalogue.
  snapshot-keys   Writes the snapshot keys an app ships, to verify snapshots offline.

Options for generate:
  --out <file>       The file to write. Defaults to src/entitler.gen.ts.
  --key <key>        An API key with the plans:read scope. Defaults to ENTITLER_KEY.
  --base-url <url>   The API's base URL. Defaults to https://api.entitler.dev.
  --check            Check the file is up to date instead of writing it.
  --allow-empty      Write the file even when Entitler lists no features.

Options for snapshot-keys:
  --out <file>       The file to write. Defaults to entitler-snapshot-keys.json.
  --base-url <url>   The API's base URL. Defaults to https://api.entitler.dev.

  --help             Show this help.
`;

const COMMANDS = {
  generate: { valued: new Set(["--out", "--key", "--base-url"]), flags: new Set(["--check", "--allow-empty"]) },
  "snapshot-keys": { valued: new Set(["--out", "--base-url"]), flags: new Set<string>() },
};

type Options = Record<string, string | true>;

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

async function readExisting(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

function failure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
  const code =
    error instanceof ApiError ? error.code : error instanceof TimeoutError ? "timed_out" : "connection_failed";
  return `Entitler request failed: ${message} (${code}).\n`;
}

function parse(command: keyof typeof COMMANDS, rest: readonly string[]): Options | string {
  const { valued, flags } = COMMANDS[command];
  const options: Options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg];
    if (flags.has(flag as string) && inline === undefined) {
      options[(flag as string).slice(2)] = true;
    } else if (valued.has(flag as string)) {
      if (inline === undefined) i += 1;
      const value = inline ?? rest[i];
      if (value === undefined || value === "") return `Pass a value with ${flag}.\n`;
      options[(flag as string).slice(2)] = value;
    } else {
      return `Unknown option ${arg}.\n\n${USAGE}`;
    }
  }
  return options;
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

async function generate(options: Options, env: Record<string, string | undefined>): Promise<[number, string]> {
  const file = (options.out as string | undefined) ?? "src/entitler.gen.ts";
  const key = (options.key as string | undefined) ?? env.ENTITLER_KEY;
  if (!key?.trim())
    return [1, "Provide an API key with --key or set ENTITLER_KEY. The key needs the plans:read scope.\n"];
  let source: Awaited<ReturnType<EntitlerServer["features"]>>;
  try {
    const baseUrl = options["base-url"] as string | undefined;
    source = await new EntitlerServer({ key, cache: false, ...(baseUrl ? { baseUrl } : {}) }).features();
  } catch (error) {
    return [1, failure(error)];
  }
  const existing = await readExisting(file);
  const rendered = renderFeatures(source, existing === undefined ? {} : { existing });
  const count = plural(source.features.length, "feature");
  if (options.check) {
    if (existing !== undefined && sameFeatures(existing, rendered))
      return [0, `${file} is up to date with ${count}.\n`];
    return [1, `${file} is out of date. Run entitler generate to update it.\n`];
  }
  if (source.features.length === 0 && !options["allow-empty"] && existing !== undefined && holdsConstants(existing)) {
    return [
      1,
      `Entitler listed no features, so ${file} was left as it is. Check the key's environment, or pass --allow-empty.\n`,
    ];
  }
  await writeAtomically(file, rendered);
  return [0, `Wrote ${count} to ${file}.\n`];
}

async function snapshotKeys(options: Options): Promise<[number, string]> {
  const file = (options.out as string | undefined) ?? "entitler-snapshot-keys.json";
  const baseUrl = options["base-url"] as string | undefined;
  let keys: Awaited<ReturnType<EntitlerServer["snapshotKeys"]>>;
  try {
    keys = await new EntitlerServer({ key: "unused", cache: false, ...(baseUrl ? { baseUrl } : {}) }).snapshotKeys();
  } catch (error) {
    return [1, failure(error)];
  }
  if (!Array.isArray(keys.keys) || keys.keys.length === 0) {
    return [1, `Entitler published no snapshot keys, so ${file} was left as it is.\n`];
  }
  await writeAtomically(file, `${JSON.stringify({ keys: keys.keys }, null, 2)}\n`);
  return [0, `Wrote ${plural(keys.keys.length, "snapshot key")} to ${file}.\n`];
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
  if (command !== "generate" && command !== "snapshot-keys") {
    err(command === undefined ? USAGE : `Unknown command ${command}.\n\n${USAGE}`);
    return 1;
  }
  const options = parse(command, rest);
  if (typeof options === "string") {
    err(options);
    return 1;
  }
  const [code, message] = command === "generate" ? await generate(options, env) : await snapshotKeys(options);
  (code === 0 ? out : err)(message);
  return code;
}
