# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-09

### Added

- `EntitlerServer`, built from a secret key, and `EntitlerClient`, built from a customer token or a
  publishable key and an identity token, both answering one `Customer` interface.
- Checks, `isEntitled` with a required default, entitlement lists with groups, the customer's plans and pricing.
- Usage: `gate` and `observe` reports, holds, `withHold` with `hold.use()`, and batches of any size
  that answer failed requests as `error` events.
- Registration, details, customer tokens, tracks, self-serve billing and vendor actions.
- Timeouts, retries with backoff and `Retry-After`, idempotency keys on every write, an answer cache
  keyed by a credential fingerprint and honouring `max-age`, `Age` and `ETag`, stale answers while
  Entitler is unreachable, redirects never followed, and token providers.
- Typed errors (including `UsageSettlementError` and `invalid_response`), offline snapshot verification, and the `entitler generate` feature-constant
  generator.
