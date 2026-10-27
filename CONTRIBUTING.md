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
| `bun run vectors` | runs the snapshot decoder's hand-written tests, then rewrites `test/fixtures/snapshot-vectors.json`, the signed snapshots and outcomes every Entitler SDK verifies alike, with a new key; rerun it only when the snapshot format changes, and share the file with the other SDKs |

## Releases

Before the first release, an npm owner of `@entitlerhq/entitler` registers this repository as a
[trusted publisher](https://docs.npmjs.com/trusted-publishers) on npmjs.com, with the workflow
`publish.yml` and the environment `release`; until then publishing can't authenticate.

1. Move the `## [Unreleased]` entries into a new `## [x.y.z] - <date>` section of `CHANGELOG.md`.
2. Set `version` in `package.json`.
3. Merge, then push the tag `vx.y.z`. `publish.yml` checks the tag matches the version and has a
   changelog section, runs every check, publishes to npm with trusted publishing and provenance from
   the `release` environment, and creates the GitHub release from the changelog section.
