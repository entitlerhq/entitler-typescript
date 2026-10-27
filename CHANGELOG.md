# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- `EntitlerServer`, the server client, with `customer(id).check()`, `isEntitled()` and `entitlements()`.
- Retries for idempotent requests, an answer cache that honours `max-age` and `ETag`, and kept answers
  standing in while Entitler is unreachable.
- `ApiError` with the API's gRPC `code`, `reason` and `parameters`.
- `recordUsage()`, and holds with `startHold()`, `withHold()`, `holdUsage()`, `settleUsage()` and
  `releaseUsage()`.
- The server's customer: `register()`, `details()`, `update()`, `erase()`, and `token()` to mint a
  customer token for an in-app client.
- `EntitlerClient`, the in-app client for one signed-in customer, built from a customer token (or a
  provider for one) or from a publishable key and an identity token. It asks the provider again
  when Entitler refuses the token, and answers through `me`. `TokenError` reports a failing provider.
- Offline snapshots: `snapshot()` asks Entitler to sign the customer's entitlements, `snapshotKeys()`
  fetches the keys that verify them without a credential, and `verifySnapshot()` checks one offline
  and answers its entitlements. `SnapshotError` reports why one fails to verify.
