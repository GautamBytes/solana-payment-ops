# PayOps release runbook

This runbook publishes a versioned seven-package PayOps bundle after its release
pull request is merged. Release preparation never creates the tag or GitHub
release and never changes npm account, organization, token, or environment
settings.

## 1. Preconditions

1. Confirm `main` is clean, current, and protected; record the exact merge SHA.
2. Confirm all required CI checks passed for that SHA.
3. From a fresh checkout with PostgreSQL 16 available, run:

   ```bash
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm release:verify
   ```

4. Confirm the target manifest lists contracts, core, ingestion, webhooks,
   reconciliation, pilot, and sdk in dependency order at one exact version.

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

## 3. Confirm protected publication

In GitHub, verify the `npm-release` environment still requires a human reviewer
and limits deployment to approved tags. Confirm npm trusted publishing is bound
to this repository, the release workflow, and that protected environment. Keep
workflow permissions limited to `contents: write` and `id-token: write`. Do not
add a long-lived npm token.

## 4. Create the exact annotated tag

Re-fetch and compare the reviewed merge SHA before tagging:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
git rev-parse HEAD
git status --short
git tag -a v<VERSION> -m "PayOps v<VERSION>" <MERGED_SHA>
git rev-parse 'v<VERSION>^{commit}'
git push origin v<VERSION>
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

For every package in the release manifest, verify the registry reports the
target version, public access, provenance, the expected repository metadata, exact
internal dependency ranges, and no unexpected files:

```bash
npm view @payops/contracts@<VERSION> --json
npm view @payops/core@<VERSION> --json
npm view @payops/ingestion@<VERSION> --json
npm view @payops/webhooks@<VERSION> --json
npm view @payops/reconciliation@<VERSION> --json
npm view @payops/pilot@<VERSION> --json
npm view @payops/sdk@<VERSION> --json
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
do not bypass the comparison. Prepare the next patch version when a fix-forward
release is required.

On a token, account, or ownership anomaly, cancel the workflow, revoke the npm
token, review npm and GitHub audit logs, rotate affected credentials, and do not
retry until account control is confirmed.

## 8. Record release evidence

Record the workflow URL, tag, merged commit, release URL, package registry URLs,
checksums, SBOM, and provenance statements. Keep the protected environment and
human approval gate in place for the next release.
