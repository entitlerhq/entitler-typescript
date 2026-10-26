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

## Releases

1. Move the `## [Unreleased]` entries into a new `## [x.y.z] - <date>` section of `CHANGELOG.md`.
2. Set `version` in `package.json`.
3. Merge, then push the tag `vx.y.z`. `publish.yml` checks the tag matches the version, runs every
   check, publishes to npm with trusted publishing and provenance from the `release` environment,
   and creates the GitHub release from the changelog section.
