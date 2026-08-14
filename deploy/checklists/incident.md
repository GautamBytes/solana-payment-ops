# Incident checklist

- [ ] Remove public traffic or block production promotion without mutating evidence.
- [ ] Classify RPC disagreement, worker staleness, migration mismatch, secret exposure, webhook exhaustion, or tenant-boundary suspicion.
- [ ] Preserve bounded logs, immutable audit/event records, image digests, and migration checksums.
- [ ] Revoke exposed credentials before rebuild; rotate dependent trust with overlap only where supported.
- [ ] Use production-control and incident APIs; do not repair state with manual SQL.
- [ ] Restore service only after readiness and a scoped verification pass.
- [ ] Record timeline, affected organizations, evidence, remediation owner, and follow-up test.
