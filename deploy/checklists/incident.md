# Incident checklist

- [ ] Name an incident owner, start a UTC timeline, and classify severity.
- [ ] Remove public traffic or block production promotion without mutating evidence.
- [ ] Classify RPC disagreement, worker staleness, migration mismatch, secret exposure, webhook exhaustion, or tenant-boundary suspicion.
- [ ] Preserve bounded logs, immutable audit/event records, image digests, and migration checksums.
- [ ] Revoke exposed credentials before rebuild; rotate dependent trust with overlap only where supported.
- [ ] Use production-control and incident APIs; do not repair state with manual SQL.
- [ ] Restore service only after readiness and a scoped verification pass.
- [ ] Record timeline, affected organizations, evidence, remediation owner, and follow-up test.

## Stable escalation conditions

| Condition                                                   | First action                                                                     | Recovery gate                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Readiness is non-200 for two consecutive checks             | Stop promotion and public traffic, then correlate the two checks by request ID.  | Dependency readiness is 200 twice on the same revision.                       |
| An RPC disagreement incident opens                          | Block production promotion and preserve both provider observations.              | The disagreement is resolved through the production-control workflow.         |
| A worker heartbeat becomes stale                            | Preserve worker lifecycle events and prevent another deployment from starting.   | One worker on the expected revision is ready and all required jobs are fresh. |
| Webhook dead-letter count grows                             | Pause delivery for the affected endpoint and preserve bounded delivery evidence. | Retry policy is verified and dead-letter growth has stopped.                  |
| A backup restore fails                                      | Stop the deployment and retain the named disposable target for diagnosis.        | A new, separately named disposable restore passes the full restore checklist. |
| Public-analysis 5xx rate exceeds 5 percent for five minutes | Disable the public-analysis flags while leaving sample mode available.           | A scoped smoke test passes before the flags are re-enabled.                   |

## Public-analysis rollback

Set the active mode's server-side flag to `false`:

- Full API: `PAYOPS_PUBLIC_ANALYSIS_ENABLED`
- Embedded Vercel route: `PAYOPS_EMBEDDED_PUBLIC_ANALYSIS_ENABLED`

Set `PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED=false` to remove the form while the
incident is active. Keep sample mode online unless the broader web readiness
gate fails. Record every flag change and deployment revision in the timeline.
