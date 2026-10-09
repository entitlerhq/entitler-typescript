# Working in this repository

The official Entitler SDK for TypeScript and JavaScript (`@entitlerhq/entitler`). These rules apply
to every contributor, people and coding agents alike.

## Before pushing

Run `bun run check`, `bun run smoke` and `ENTITLER_TEST_KEY=… bun run test:integration`. The
repository's only required check is `All checks passed` in `ci.yml`: keep that name, and keep every
other job in its `needs`.

## Copy and comments

- All prose (README, docs, doc comments, error messages, CLI output, changelog) is Australian
  English, sentence case, no emoji.
- Never write "get" in prose; name the thing ("the customer's entitlements", "Quick start"). No vague
  "what" clauses.
- Every public type, function, method, property and constant has a doc comment. No other comments:
  rename, extract or restructure instead. Tool directives are the only exception, each with a reason.
- Keep the SDK light: no runtime dependencies, no layers or options no requirement asks for.

## Authorship and pull requests

- Every commit is authored and committed by Romain Francez
  `<1330814+romainfrancez@users.noreply.github.com>`. Set `git config user.name` and `user.email`
  before the first commit.
- Commit messages and pull requests carry no attribution to the tools that helped write them: no
  co-author or session trailers, no generated-by lines, no session links and no model names.
- The repository never names the tools that wrote it, in any file, commit or branch. Search the tree
  and the history, ignoring case, before every push.
- Never open, edit or comment on pull requests, issues or reviews; the only write to GitHub is
  `git push`. Never create tags or publish packages.
