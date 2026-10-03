# GitHub deploy control v1

A small Ubuntu user-service control plane for two fixed, nonfinancial targets:

- `worker-v1`: this request worker and its independent updater engine
- `receipt-probe-v1`: a deliberately isolated deployment test service that writes a release-specific completion receipt

This is not a production deployment profile for the dashboard, trading systems, or other application services. The probe proves file activation and service execution, not business-application health.

## Bootstrap and normal operation

The separately reviewed initial bootstrap installs an anchored launcher, authority policy, existing-auth adapter, and fixed systemd user units. Credentials remain in VM memory and are read through the existing phone worker's pinned loader. Ordinary reviewed engine updates then use GitHub alone; they do not require another PC bootstrap. General unit-template migrations, authority changes, new credentials, and new deployment targets are outside this v1 envelope.

`hermes-deploy-worker.service` polls and admits requests. `hermes-deploy-updater.service` is a separate oneshot process started by a timer or the worker. It survives stopping the request worker. `hermes-deploy-probe.service` is a oneshot test target with no listener. Existing phone and application services are not controlled by these profiles.

All components run under one existing Unix user. Manifest and request checks govern trusted, reviewed code; they are not an OS sandbox against a malicious same-user package. Commit SHA and SHA-256 hashes bind exact bytes, not a cryptographic publisher signature.

## Requests

Post a new, unedited comment to the bootstrap's fixed control issue from its fixed authorized GitHub account. The comment begins with `DEPLOY_CONTROL_V1`, a newline, then one JSON object. IDs are unique 8–64 character strings containing letters, digits, `_`, or `-`. Admission expires after one hour. Unknown fields, arbitrary commands, paths, URLs, environment variables, and service names are rejected.

| Operation | Profile | Additional fields |
| --- | --- | --- |
| `deploy.verify` | `repo-verify-v1` | `repo`, full lowercase 40-character `sha` |
| `deploy.apply` | `receipt-probe-v1` | `repo: "Hermes"`, exact `sha` |
| `deploy.update_self` | `worker-v1` | `repo: "Hermes"`, exact `sha` |
| `deploy.status`, `deploy.health`, `deploy.restart_service`, `deploy.rollback` | `worker-v1` or `receipt-probe-v1` | none |

Example (replace the placeholder with the reviewed merged commit):

```text
DEPLOY_CONTROL_V1
{"id":"probe_release_0001","operation":"deploy.apply","profile":"receipt-probe-v1","repo":"Hermes","sha":"<full-reviewed-main-commit-sha>"}
```

Repository IDs and branch ancestry are checked against the anchored policy. Hermes source packages come only from `ops/deploy-control` and `ops/deploy-control/probe`. KIS is available only for commit verification. Worker manifests list exactly five source files; probe manifests list only `probe.py`. Packages cannot supply install hooks, anchored launcher/auth files, policy, or unit templates. Changed installed unit settings are refused.

Regenerate package manifests after a reviewed source change using the separate build tool's `--write-manifests` operation before committing. The manifest records each file's byte size and SHA-256. The initial bootstrap is constructed only after the reviewed source commit is published and merged.

## Recovery and health

SQLite WAL with synchronous FULL stores accepted requests, intent, command observations, target quarantine, and the result outbox. Prepared effects are never blindly rerun after an ambiguous timeout. An already accepted recovery transaction does not depend on the request TTL, later comment edits, or GitHub availability. Queued requests are revalidated before their first effect.

The anchored launcher selects the retained old updater and verifies its manifest digest before importing updateable modules when recovery is pending. A self-update commits only after a fresh worker receipt and a candidate updater interface/schema smoke test. Positive candidate failure restores the exact retained release if pointer, service, and unit ownership still match. Conflicts and unresolved observations become `UNKNOWN_OUTCOME` or `MANUAL_RECOVERY_REQUIRED`; another request cannot bypass a quarantined target. Releases, ledgers, and recovery evidence are retained.

Health binds release, pointer generation, unit identity, systemd invocation, process start, and attempt. Read-only health never restarts a service. The completed probe receipt remains valid for the same invocation/generation; update activation additionally requires a fresh attempt receipt. Bootstrap admits requests but holds their effects until initial installation health commits.

The updater performs at most one operation per invocation, applies a shared 540-second external-call deadline, reserves recovery time before preparing a deployment, and has a 600-second systemd startup timeout. Exceptional machine, filesystem, credential, GitHub, or operator conflicts can still require manual recovery. Normal-operation recovery is designed to run without a PC, not guaranteed under every failure.

Results are comments beginning `DEPLOY_CONTROL_RESULT_V1 <id>`, followed by bounded JSON. A response lost during posting is reconciled by its marker rather than blindly reposted; this is not an exactly-once delivery guarantee. Runtime `SELF_UPDATE: PASS` and `AUTO_ROLLBACK: PASS` indicators describe actual completed transactions only. Cloud tests do not establish VM deployment success.

## Validation

Run `python3 -m unittest discover -q` from this directory. The published tests exercise protocol and manifest checks, durable recovery, subprocess independence, launcher/host receipt integration, bootstrap barriers, read-only health, and failure restoration with local filesystem/process/systemd models. Real VM systemd and GitHub end-to-end outcomes must be recorded separately after installation. Bootstrap-only tests and credential adapter sources are maintained with the separate private bootstrap bundle.
