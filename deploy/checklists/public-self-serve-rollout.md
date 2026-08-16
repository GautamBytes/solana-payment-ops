# Public self-serve rollout

This checklist is reusable deployment guidance, not a paid-service requirement
for the pull request. Merge requires local container and browser verification.
Before grant funding, use only existing or free allocations and do not enable a
billing commitment to complete this checklist.

Keep both public-analysis feature flags false until the readiness and bounded
analysis gates pass.

## Full API mode

1. Apply migrations through `4016_public_analysis_rate_limits.sql`.
2. Configure distinct runtime, control, readiness, migrator, and projector
   database roles.
3. Configure two distinct mainnet RPC providers.
4. Deploy the API and confirm both API health endpoints.
5. Deploy the worker and wait for worker readiness.
6. Set the web and API origins exactly. Set
   `NEXT_PUBLIC_PAYOPS_API_ORIGIN` equal to `PAYOPS_API_ORIGIN` byte for byte.
7. Set `PAYOPS_PUBLIC_ANALYSIS_ENABLED` and
   `PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED` to `true`.
8. Deploy the web application and run `pnpm hosted:self-serve:check` with
   `PAYOPS_WEB_ORIGIN` and `PAYOPS_PUBLIC_API_ORIGIN` in the operator
   environment.
9. Submit one valid wallet analysis and one intentional rate-limit scenario.
10. Set both feature flags back to `false` if readiness, privacy, rate limiting,
    or bounded analysis fails.

## Zero-cost embedded demonstration

Use this mode only for the public, read-only Try PayOps experience. It does not
replace the full API deployment for merchant operations.

1. Add a Vercel WAF rule for `/v1/public-wallet-analysis` that limits each IP
   to 5 requests per minute and returns HTTP 429 above the limit.
2. Confirm the rule is active before setting
   `PAYOPS_PUBLIC_ANALYSIS_EDGE_RATE_LIMITED=true`.
3. Set `PAYOPS_EMBEDDED_PUBLIC_ANALYSIS_ENABLED=true` and configure the
   server-only `PAYOPS_PUBLIC_SOLANA_RPC_URL` with a secure mainnet endpoint.
4. Set `PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED=true` and deploy the web app.
5. Run the embedded hosted check with `PAYOPS_WEB_ORIGIN` and
   `PAYOPS_HOSTED_SELF_SERVE_MODE=embedded` in the operator environment.
6. Submit one valid address and confirm the response is schema `0.1`, bounded,
   uncached, and either complete or explicitly partial.
7. Set both web feature flags back to `false` if the WAF rule, readiness, safe
   errors, or bounded analysis check fails.

The checker is read-only. It prints one bounded status line per check and never
prints origins, response bodies, credentials, wallet addresses, or provider
details.
