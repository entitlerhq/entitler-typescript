# Feature constants

A feature constant holds a feature's `key`, its `type` (`boolean`, `config`, `metered` or `group`)
and, for a group, its leaf members (`includes`). The type flows into the answer, so
`check(features.aiCredits)` is a `Check<"metered">` with its meter, and usage methods accept only
metered features.

## The generator

```sh
ENTITLER_KEY=ent_test_… npx entitler generate --out src/entitler.gen.ts
bunx entitler generate --out=src/entitler.gen.ts --check
```

| Option | Meaning |
| --- | --- |
| `--out <file>` | the file to write; `src/entitler.gen.ts` by default |
| `--key <key>` | an API key with `plans:read`; `ENTITLER_KEY` by default |
| `--base-url <url>` | the API's base URL |
| `--check` | exit 1 unless the file is up to date, ignoring the release it was read from |
| `--help` | show the usage |

Each feature becomes a constant named in camelCase, sorted by key, with its name, description, unit,
a group's members, and `@deprecated Archived in Entitler.` once archived. When the file already
exists, each feature keeps the name it had, so adding a feature never renames another. A name that is
not a valid identifier, is a reserved word, or is taken is escaped deterministically: a leading `_`
before a digit, a trailing `_` after a reserved word, then a number.

Run `--check` in CI to catch a catalogue change the code has not caught up with.

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
