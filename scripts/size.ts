import { gzipSync } from "node:zlib";

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
const lines: string[] = ["| Entry | Minified | Minified and gzipped |", "| --- | --- | --- |"];

for (const entry of ["dist/index.js", "dist/generate.js", "dist/testing.js"]) {
  const result = await Bun.build({ entrypoints: [entry], minify: true, target: "browser", external: ["node:*"] });
  if (!result.success) throw new AggregateError(result.logs, `Could not bundle ${entry}.`);
  const code = await (result.outputs[0] as Blob).text();
  lines.push(`| ${entry} | ${kib(code.length)} | ${kib(gzipSync(code).length)} |`);
}

const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], { stderr: "ignore" });
const [tarball] = JSON.parse(pack.stdout.toString()) as { size: number; unpackedSize: number; entryCount: number }[];
if (tarball) {
  lines.push(
    "",
    `Package: ${kib(tarball.size)} packed, ${kib(tarball.unpackedSize)} unpacked, ${tarball.entryCount} files.`,
  );
}

const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await Bun.write(process.env.GITHUB_STEP_SUMMARY, `## Size\n\n${report}\n`);
