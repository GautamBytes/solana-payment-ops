# Changelog

All notable public changes to PayOps are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic
versioning for its public packages.

## [Unreleased]

## [0.1.1] - 2026-08-19

### Added

- Added the self-serve Try PayOps sample workspace and bounded public-wallet
  inspection.

### Changed

- Made `solanapayops.xyz` the canonical public website origin.
- Updated package and project metadata for the `payops-labs` organization.

### Security

- Added structured operational logging, readiness correlation, hardened web
  headers, dependency review, CodeQL, and recovery runbooks.

## [0.1.0] - 2026-08-14

### Added

- Seven-package Apache-2.0 open-core bundle: contracts, payment verification,
  ingestion, transactional webhooks, reconciliation, merchant shadow audits,
  and the merchant API SDK.
- Deterministic Solana USDC/USDT evidence parsing, strict lifecycle schemas,
  PostgreSQL-backed operational state, and native ESM interfaces.
- Reproducible package-content checks, clean-consumer smoke tests, release
  evidence, checksums, SPDX SBOM generation, and provenance-aware publication.

[Unreleased]: https://github.com/payops-labs/solana-payment-ops/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/payops-labs/solana-payment-ops/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/payops-labs/solana-payment-ops/releases/tag/v0.1.0
