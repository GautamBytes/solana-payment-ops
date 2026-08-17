# API rate-limit control evidence

Last reviewed: 2026-08-17

## Decision

PayOps uses database-backed fixed-window limits instead of process-local middleware. This is deliberate: counters must remain effective when the API runs across several instances or restarts during a window.

The review of CodeQL alerts 1-33 found one missing control and 32 scanner-model gaps. The missing control was the public bootstrap-acceptance endpoint. It is now limited before request parsing, password hashing, or invitation acceptance. The other handlers already consumed a durable limit after authentication or public-token resolution and before application-store work.

CodeQL's JavaScript `js/missing-rate-limiting` query recognizes a set of common npm middleware packages. It does not infer PayOps' custom PostgreSQL stores or route helper functions. A scanner alert is therefore not, by itself, evidence that these handlers run without a limit.

## Durable controls

Authenticated organization routes use `RateLimitStore` and `api_rate_limit_buckets`. A bucket is scoped by organization, actor kind, actor ID, route group, and time window. PostgreSQL performs the increment and conflict update atomically. A denied claim returns HTTP 429 with `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining` before the protected store operation runs.

Unauthenticated bootstrap and public wallet analysis use `PublicAnalysisRateLimitStore` and `public_analysis_rate_limit_buckets`. Client addresses are HMAC-digested before storage. Each use case has a separate namespace, so bootstrap traffic cannot exhaust public-analysis capacity and vice versa. Both a client bucket and a global bucket are incremented in one transaction.

The public controls fail closed. If the durable limiter cannot make a decision, the route returns HTTP 503 and does not hash a password, accept an invitation, or call a Solana RPC provider.

## Alert review map

| Alerts               | Source                                                     | Protected operations                                                                    | Control placement                                                                                                  |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1-3                  | `routes/customers.ts`                                      | Create, list, and read customers                                                        | Direct `consume` call after permission checks                                                                      |
| 4-8                  | `routes/merchant-wallets.ts`                               | Wallet read and owner mutations                                                         | Direct `consumeRateLimit` call after actor resolution                                                              |
| 9-13                 | `routes/invoices.ts`                                       | Invoice reads and writes                                                                | Direct `consume` call before invoice-store access                                                                  |
| 14-16, 18, 20, 22-23 | `routes/operational-health.ts`                             | Production status, health, incidents, history, incident mutations, production promotion | Shared `reader`, `operator`, and `owner` guards call `consume` before returning an actor                           |
| 17, 19, 21, 24-30    | `routes/operations.ts`                                     | Exceptions, evidence packs, and accounting exports                                      | Direct `consume` call before protected work                                                                        |
| 31-32                | `routes/public-checkout.ts`                                | Merchant checkout management                                                            | `consumeMerchant` after authenticated actor resolution; public checkout paths also use HMAC-scoped `consumePublic` |
| 33                   | Formerly `server.ts`, now `routes/bootstrap-acceptance.ts` | Owner invitation acceptance                                                             | Newly added namespaced durable public limit before password hashing                                                |

`scripts/test/rate-limit-control-evidence.test.mjs` pins this reviewed route coverage. Route additions or removals must update both the executable evidence and this document. Runtime tests separately verify denial responses and confirm that protected work is not called after a rejected claim.

## Scanner disposition

Alert 33 represented a real gap and should close after CodeQL analyzes the new bootstrap route. If CodeQL reports the new helper for the same reason, retain the finding only long enough to link this evidence and the rejection test, then dismiss it as a false positive caused by an unsupported custom limiter.

Alerts 1-32 may be dismissed as false positives after the branch is merged and the default-branch scan confirms the reviewed source locations. Each dismissal should reference this document, the database migration that owns the relevant bucket table, and the route-coverage test. A dismissal is not appropriate if the guard, database increment, or fail-closed response has been removed.
