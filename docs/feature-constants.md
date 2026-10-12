# Feature constants

A feature constant holds a feature's `key`, its `type` (`boolean`, `config`, `metered` or `group`)
and, for a group, its leaf members (`includes`). The type flows into the answer, so
`check(features.aiCredits)` is a `Check<"metered">` with its meter, and usage methods accept only
metered features.

Name the scoped package in `npx` and `bunx`, so no unscoped package called `entitler` is ever
fetched.

## The generator

Generate from the live environment's key, with `plans:read`. A test environment can hold features
that are not released yet, and constants generated from it would ship them in your code.

```sh
ENTITLER_KEY=ent_live_… npx @entitlerhq/entitler generate --out src/entitler.gen.ts
bunx @entitlerhq/entitler generate --out=src/entitler.gen.ts --check
```

| Option | Meaning |
| --- | --- |
| `--out <file>` | the file to write; `src/entitler.gen.ts` by default |
| `--key <key>` | an API key with `plans:read`; `ENTITLER_KEY` by default |
| `--base-url <url>` | the API's base URL |
| `--check` | exit 1 unless the file is up to date, ignoring the release it was read from; writes nothing |
| `--allow-empty` | write the file even when Entitler lists no features |
| `--help` | show the usage |

When Entitler lists no features and the file already holds constants, the generator leaves the file
as it is and exits 1, since an empty catalogue usually means a key for the wrong environment. Pass
`--allow-empty` to write the file with no features instead. With no file there yet, it writes one
either way.

Each feature becomes a constant named in camelCase, sorted by key, with its name, description, unit,
a group's members, and `@deprecated Archived in Entitler.` once archived. When the file already
exists, each feature keeps the name it had, so adding a feature never renames another. A name that is
not a valid identifier, is a reserved word, or is taken is escaped deterministically: a leading `_`
before a digit, a trailing `_` after a reserved word, then a number.

Run `--check` in CI to catch a catalogue change the code has not caught up with, wherever the key is
available: on pushes to the main branch and on pull requests from branches of the same repository.
Pull requests from forks receive no secrets, so skip the check there rather than fail it, for
example in GitHub Actions:

```yaml
- if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
  run: npx @entitlerhq/entitler generate --check
  env:
    ENTITLER_KEY: ${{ secrets.ENTITLER_LIVE_KEY }}
```

`renderFeatures` from `@entitlerhq/entitler/generate` renders the same file, for build tooling.

## By hand

```ts
import { defineFeature } from "@entitlerhq/entitler";

export const handMade = {
  exportPdf: defineFeature("export_pdf", "boolean"),
  aiCredits: defineFeature("ai_credits", "metered"),
  collaboration: defineFeature("collaboration", "group", ["team_seats", "shared_folders"]),
};
```

Feature arguments also take plain keys (`customer.check("export_pdf")`), which answer a general
`Check`.
