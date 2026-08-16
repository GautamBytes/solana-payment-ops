# Hosted environment contract

PayOps treats configuration as capability assignment. A secret store must inject values at runtime; do not bake them into images, build arguments, labels, Compose files, or browser variables.

| Service        | Database variables                                   | Other required capability                                                                                   |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| role bootstrap | `PAYOPS_DATABASE_ADMIN_URL`                          | Five restricted login principal names                                                                       |
| migrator       | `PAYOPS_MIGRATOR_DATABASE_URL`                       | None                                                                                                        |
| API            | runtime, production-control, readiness-verifier URLs | HTTPS origins, dual RPC identity, auth/checkout keys, Pyth, email, evidence signing                         |
| worker         | runtime and shadow-projector URLs                    | dual RPC identity and bounded worker settings                                                               |
| web            | none                                                 | exact web/API origins; server-only readiness origin; only `NEXT_PUBLIC_PAYOPS_API_ORIGIN` is client-visible |

The web deployment uses the same hosted API origin in server and browser
contexts:

| Web variable                    | Source                    | Rule                                                                   |
| ------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `PAYOPS_WEB_ORIGIN`             | Public web deployment URL | Exact HTTPS origin                                                     |
| `PAYOPS_API_ORIGIN`             | Hosted API deployment URL | Exact HTTPS origin                                                     |
| `NEXT_PUBLIC_PAYOPS_API_ORIGIN` | Hosted API deployment URL | Must equal `PAYOPS_API_ORIGIN` byte for byte                           |
| `PAYOPS_API_READINESS_ORIGIN`   | Web server only           | Optional exact HTTPS origin; local Compose uses only `http://api:3000` |

The administrator is used only to create restricted principals and capability roles. Remove it from the deployment job before migrations. The migrator is a one-shot capability and must never be present in API, worker, or web.

Production requires `PAYOPS_ENVIRONMENT=production`, HTTPS exact origins, `mainnet-beta`, two distinct provider IDs with separately named endpoint variables, production email delivery, and an Ed25519 evidence-signing key. Without both authenticated commercial-FX variables, only USD invoices are enabled.

`BETTER_AUTH_SECRETS`, checkout token keys, evidence keys, database URLs/passwords, provider tokens, email tokens, and endpoint-specific webhook sender secrets are secret. Values in `.env.example` are inventory markers, not usable defaults.

## Public-wallet analysis rollout

Public-wallet analysis is an optional, read-only capability. Keep both
`PAYOPS_PUBLIC_ANALYSIS_ENABLED` and
`PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED` false by default. Enable the web flag
only after migration `4016_public_analysis_rate_limits.sql` is applied, the API
is ready with the API flag enabled, trusted-origin CORS is verified, and a
bounded mainnet smoke succeeds.

The client limit, global limit, and window variables bound anonymous use. The
client digest secret is an API-only HMAC secret: never expose it to web, a
browser variable, logs, or analytics. Public analysis stores only rate-limit
digests and counters; wallet addresses and results remain request-scoped.

### Embedded web mode

The web application also supports a narrow, read-only embedded mode for the
self-serve demonstration. This mode does not start the full API, worker, or
database and must not be used for authenticated merchant operations.

| Variable                                   | Value                  | Rule                                                    |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------- |
| `PAYOPS_EMBEDDED_PUBLIC_ANALYSIS_ENABLED`  | `true`                 | Enables only the same-origin read-only route            |
| `PAYOPS_PUBLIC_ANALYSIS_EDGE_RATE_LIMITED` | `true`                 | Set only after the Vercel WAF rate-limit rule is active |
| `PAYOPS_PUBLIC_SOLANA_RPC_URL`             | Secure mainnet RPC URL | Server-only; never prefix with `NEXT_PUBLIC_`           |
| `PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED`    | `true`                 | Shows the public-wallet form                            |

The embedded route accepts same-origin JSON POST requests only. It scans at
most 40 signatures and 20 transactions, uses concurrency 2, and aborts
upstream work after 20 seconds. It never persists wallet addresses or results.
Keep the edge-rate-limit assertion false until a project-level rule protects
`/v1/public-wallet-analysis` by client IP.
