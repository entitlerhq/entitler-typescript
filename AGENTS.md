# Working in this repository

The Entitler SDK for TypeScript and JavaScript (`@entitlerhq/entitler`). These rules apply to every
contributor, people and coding agents alike.

- Use Bun for scripts. Before pushing, run every command in [CONTRIBUTING.md](CONTRIBUTING.md).
- `All checks passed` in `ci.yml` is the only required check: keep its name, and keep every other
  job in its `needs`.
- Write prose (docs, doc comments, error messages, the changelog) in Australian English, in
  sentence case and with no emoji.
- Give every public type, function and property a doc comment, and write no other comments.
- Add no runtime dependencies.
- Keep one change per pull request, based on `main`. History is linear: no merge commits, and no
  amended commits.
- Never commit secrets or internal hostnames.
