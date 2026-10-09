# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-09

### Added

- `EntitlerServer`, built from a secret key, and `EntitlerClient`, built from a customer token, a
  publishable key and an identity token, or a publishable key alone for signed-out `pricing()`. Each
  refuses the other kind of key, and both `close()`.
- One `Customer` interface for both: checks, `isEntitled` with a required default, entitlement lists
  with groups, `plans()` as the billing page's one read, pricing, and `revalidate` on cached reads.
- Usage under required idempotency keys: `gate` and `observe` reports, `startHold` answering a `Hold`
  handle (`use`, `finish`, `release`, `await using`), `withHold` over it, and batches whose request
  keys derive from their events.
- Billing by intent: `subscribe` answering its next step (`done`, `pay`, `confirming`, `manage`),
  `cancel`, `undoPendingChange`, `billingPortal` and `syncBilling`; and the company's `setPlan` with
  `billing` and `until`, `setAddOn`, `grant`, `revokeGrant`, `adjustMeter` and `cancelUsage`.
- Registration, details, `erase()`, customer tokens with the fewest scopes, tracks by name, and
  `asOf` on the server customer's reads.
- Timeouts, retries with backoff and `Retry-After`, idempotency keys on every write with `replayed` on
  their answers, an answer cache keyed by a credential fingerprint and honouring `max-age`, `Age` and
  `ETag`, stale answers while Entitler is unreachable, redirects never followed, and token providers.
- Typed errors (including `UsageReplayedError`, `UsageSettlementError` and `invalid_response`),
  `isUnreachable()`, offline snapshot verification, the stored visitor helpers, and the `entitler`
  command line's `generate` and `snapshot-keys`.
- `@entitlerhq/entitler/testing`: `fakeCustomer()` and answer builders for apps' own tests.
