import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

const out = "test/docs/out";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(`${out}/entitler.gen.ts`, await readFile("examples/generated-features/entitler.gen.ts", "utf8"));

const sources = [
  "README.md",
  ...(await readdir("docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
];
let count = 0;
for (const source of sources) {
  const text = await readFile(source, "utf8");
  const blocks = [...text.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1] as string);
  for (const [index, block] of blocks.entries()) {
    const name = `${source.replace(/[/.]/g, "_")}_${index + 1}.ts`;
    await writeFile(`${out}/${name}`, `${block}\nexport {};\n`);
    count += 1;
  }
}
console.log(`Extracted ${count} snippets from ${sources.length} files.`);
