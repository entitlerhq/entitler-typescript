# Contributing

## Setup

Install [Bun](https://bun.sh) 1.4 or later, Node.js 22 or later and, to run the suite on Deno,
[Deno](https://deno.com) 2. Then:

```sh
bun install
```

## Commands

| Command | What it does |
| --- | --- |
| `bun run lint` | Biome lint and format check (`bun run format` fixes) |
| `bun run typecheck` | type-checks the source and the tests |
| `bun run build` | builds `dist` with `tsc` |
| `bun run test` | the unit suite on Node.js; `bun --bun x vitest run test/unit` on Bun; `deno run -A npm:vitest@4.1.11 run test/unit` on Deno |
| `bun run test:coverage` | the unit suite with coverage, failing below 90% of lines |
| `bun run test:integration` | the live API suite |
| `bun run docs` | the API reference (warnings fail), then type-checks every snippet in the README and `docs/` |
| `bun run examples` | type-checks the examples |
| `bun run package:check` | packs the package, runs publint and Are the Types Wrong, and reports its size |
| `bun run smoke` | builds, then runs the SDK in headless Chromium and in workerd (set `CHROMIUM_PATH` to use an installed Chromium; otherwise run `bunx playwright-core install chromium` once) |
| `bun run check` | everything above but the smoke checks and the live API suite |

## Tests

Unit tests use a fake `fetch` and fake timers, and never touch the network. The live API suite runs
against `https://api.entitler.dev` with the key in `ENTITLER_TEST_KEY`, and is skipped when it is
unset:

```sh
ENTITLER_TEST_KEY=ent_test_… bun run test:integration
```

It never writes the catalogue, tracks or keys. Each customer it creates is named
`sdk-typescript-<random>` and deleted with `erase`, so several runs can share the environment.

Generator golden files live in `test/fixtures/generate`; refresh them with
`UPDATE_GOLDEN=1 bun run test` and review the diff.

## Releases

1. Move the `## [Unreleased]` entries into a new `## [x.y.z] - <date>` section of `CHANGELOG.md`.
2. Set `version` in `package.json` and `VERSION` in `src/version.ts` (a unit test checks they agree).
3. Merge, then push the tag `vx.y.z`. `publish.yml` checks the tag matches the version, runs every
   check, publishes to npm with trusted publishing and provenance from the `release` environment,
   and creates the GitHub release from the changelog section.
