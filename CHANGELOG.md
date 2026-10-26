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
