# Public self-serve rollout

This checklist is reusable deployment guidance, not a paid-service requirement
for the pull request. Merge requires local container and browser verification.
Before grant funding, use only existing or free allocations and do not enable a
billing commitment to complete this checklist.

Keep both public-analysis feature flags false until the readiness and bounded
analysis gates pass.

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

The checker is read-only. It prints one bounded status line per check and never
prints origins, response bodies, credentials, wallet addresses, or provider
details.
