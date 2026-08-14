# PayOps release runbook

This runbook publishes the seven-package `v0.1.0` bundle after its preparation
pull request is merged. The feature branch must never create the tag, GitHub
release, npm organization, token, environment, or package versions.

## 1. Preconditions

1. Confirm `main` is clean, current, and protected; record the exact merge SHA.
2. Confirm all required CI checks passed for that SHA.
3. From a fresh checkout with PostgreSQL 16 available, run:

   ```bash
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm release:verify
   ```

4. Confirm `release/manifests/0.1.0.json` is the only release manifest and lists
   contracts, core, ingestion, webhooks, reconciliation, pilot, and sdk in that
   order, all at `0.1.0`.

Do not continue from a dirty checkout or a commit other than the reviewed merge
SHA.

## 2. Prove npm scope control

Sign in interactively on a trusted operator machine and verify the account:

```bash
npm whoami
npm org ls payops
```

The authenticated username must equal the repository variable
`NPM_SCOPE_OWNER` and must own the `@payops` organization. Stop on any mismatch.
Do not paste authentication output or tokens into issues, chat, or CI logs.

## 3. Bootstrap protected publication

In GitHub, create or verify an `npm-release` environment with a required human
reviewer and deployment-branch/tag protection. Set `NPM_SCOPE_OWNER` as a
repository or environment variable.

For the bootstrap release only, create a short-lived granular npm automation
token restricted to the `@payops` scope and publication permissions. Store it
as the environment secret `NPM_TOKEN`; never pass it as a command-line argument
or write it to a file. Confirm the release workflow grants only
`contents: write` and `id-token: write`.

## 4. Create the exact annotated tag

Re-fetch and compare the reviewed merge SHA before tagging:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
git rev-parse HEAD
git status --short
git tag -a v0.1.0 -m "PayOps v0.1.0" <MERGED_SHA>
git rev-parse 'v0.1.0^{commit}'
git push origin v0.1.0
```

The two commit SHAs must match and status must be empty. Push only the tag. The
tag starts the serialized release workflow; approve the `npm-release`
environment only after GitHub shows the expected commit and workflow file.

## 5. Observe the release

The workflow must, in order:

1. install from the frozen lockfile with lifecycle scripts disabled;
2. run repository, schema, OpenAPI, conformance, package, and production-audit
   gates;
3. prove the tag points to the checked-out commit and the npm user owns the
   scope;
4. build schemas, conformance output, package inventory, checksums, and an SPDX
   SBOM before publication;
5. publish in dependency order with public access and provenance; and
6. create the GitHub release only after npm publication succeeds.

Stop rather than bypassing any failed ownership, integrity, audit, or package
check.

## 6. Verify published output

For every package in the release manifest, verify the registry reports version
`0.1.0`, public access, provenance, the expected repository metadata, exact
internal dependency ranges, and no unexpected files:

```bash
npm view @payops/contracts@0.1.0 --json
npm view @payops/core@0.1.0 --json
npm view @payops/ingestion@0.1.0 --json
npm view @payops/webhooks@0.1.0 --json
npm view @payops/reconciliation@0.1.0 --json
npm view @payops/pilot@0.1.0 --json
npm view @payops/sdk@0.1.0 --json
```

Download the GitHub release assets and verify `SHA256SUMS`. Inspect the SPDX
SBOM, schema archive, fixture manifest, and conformance result. In a new
temporary directory, install all seven exact versions and repeat the native ESM
imports and CLI smoke checks performed by `pnpm packages:verify`. Record the
workflow URL, release URL, registry URLs, merged SHA, and tag object SHA.

## 7. Partial publication and recovery

The publisher is intentionally resumable. A rerun skips a version only when the
registry's integrity is byte-identical to the freshly packed tarball. If a job
stops after some packages publish, preserve logs and rerun the same protected
tag workflow only after diagnosing the failure. Never overwrite, unpublish, or
reuse `0.1.0`.

If no package has published and the tag itself is wrong, stop and obtain
explicit maintainer approval before deleting and recreating the remote tag. If
any bytes differ, treat the version as immutable and potentially compromised;
do not bypass the comparison. Prepare a coordinated `0.1.1` when a fix-forward
release is required.

On a token, account, or ownership anomaly, cancel the workflow, revoke the npm
token, review npm and GitHub audit logs, rotate affected credentials, and do not
retry until account control is confirmed.

## 8. Remove bootstrap credentials

After verifying the first publication, configure npm trusted publishing for
this repository, the release workflow, and the protected `npm-release`
environment. Test it in the next approved release. Then revoke the granular
bootstrap token and remove `NPM_TOKEN` from GitHub. Keep the protected
environment and human approval gate.
