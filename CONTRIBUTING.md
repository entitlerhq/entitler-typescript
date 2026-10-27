# Contributing

## Setup

Install [Bun](https://bun.sh) 1.4 or later and Node.js 22 or later. Then:

```sh
bun install
```

## Commands

| Command | What it does |
| --- | --- |
| `bun run lint` | Biome lint and format check (`bun run format` fixes) |
| `bun run typecheck` | type-checks the source, the tests and the scripts |
| `bun run build` | builds `dist` with `tsc` |
| `bun run test` | the unit suite (`bun run test:coverage` adds coverage, failing below 90% of lines) |
| `bun run generate` | regenerates `src/wire.gen.ts` from `openapi.json`, the API document |

## Releases

1. Move the `## [Unreleased]` entries into a new `## [x.y.z] - <date>` section of `CHANGELOG.md`.
2. Set `version` in `package.json`.
3. Merge, then push the tag `vx.y.z`. `publish.yml` checks the tag matches the version and has a
   changelog section, runs every check, publishes to npm with trusted publishing and provenance from
   the `release` environment, and creates the GitHub release from the changelog section.
