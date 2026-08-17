# Security policy

PayOps verifies and reconciles Solana payment evidence. It is non-custodial:
the project does not hold private keys, sign transactions, or move funds.
Security reports are still important because incorrect verification,
reconciliation, authentication, or webhook behavior can affect payment
operations.

## Supported versions

The supported public package line is `0.1.x`. Security fixes are applied to the
latest supported release and to `main` while the next release is being
prepared.

## Report privately

Use GitHub's
[private vulnerability reporting](https://github.com/GautamBytes/solana-payment-ops/security/advisories/new)
flow. Do not open a public issue for a suspected vulnerability. Include the
affected component and version, impact, prerequisites, and the smallest safe
reproduction you can provide.

Never include wallet secrets, private keys, or seed phrases. Do not include
production credentials, access tokens, customer payment data, unredacted
merchant reports, or credential-bearing RPC URLs. Replace real transaction and
account data with sanitized fixtures whenever possible.

## What happens next

Maintainers will acknowledge the report, validate and classify it, coordinate a
fix and release when required, and communicate when disclosure is safe. The
time needed depends on impact and reproducibility, so this policy does not
promise a fixed response or remediation deadline.

Please keep the report private until maintainers confirm that affected users
have a safe upgrade path. Coordinated, good-faith research that avoids data
access, service disruption, social engineering, and movement of funds is
welcome.
