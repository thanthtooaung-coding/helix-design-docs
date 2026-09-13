---
title: "4. Deployment Pipeline"
description: "Git push to live URL, step by step, with the failure handling for each stage."
sidebar:
  order: 4
---

## 4.1 End-to-end flow

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    A[Developer: git push / CLI deploy / PR opened] --&gt; B{Source}
    B --&gt;|webhook| C[Git Integration]
    B --&gt;|tarball upload| D[Upload endpoint → S3]
    B --&gt;|image ref| E[External image import]
    C --&gt; F[Deployment API: POST /v1/deployments]
    D --&gt; F
    E --&gt; F
    F --&gt; G[Validate: quota, config schema, permissions&lt;br/&gt;Create deployment row = QUEUED&lt;br/&gt;Write outbox event]
    G --&gt; H[(NATS: builds.queue)]
    H --&gt; I[Build Worker claims job]
    I --&gt; J[Provision build microVM&lt;br/&gt;rootfs = builder image + BuildKit]
    J --&gt; K[Fetch source: git clone --depth 1 / S3 tarball]
    K --&gt; L[Synthesize Dockerfile/LLB from helix.yaml + runtime definition]
    L --&gt; M[BuildKit build with cache mounts + secret mounts]
    M --&gt; N{Success?}
    N --&gt;|no| N1[FAILED — logs retained, VM destroyed]
    N --&gt;|yes| O[Push image to registry by digest]
    O --&gt; P[SBOM syft + scan trivy + sign cosign]
    P --&gt; Q{Policy pass?}
    Q --&gt;|no| Q1[FAILED_POLICY]
    Q --&gt;|yes| R[Create release: immutable ReleaseSpec]
    R --&gt; S[Scheduler: placement decision]
    S --&gt; T[AssignInstance → worker agents]
    T --&gt; U[Agent: rootfs prepare → net → Firecracker boot → vminit → app]
    U --&gt; V{Startup probe healthy before deadline?}
    V --&gt;|no| V1[Instance failed → retry on another worker&lt;br/&gt;N failures → deployment FAILED, no traffic shift]
    V --&gt;|yes| W[Instance READY, registered in route table]
    W --&gt; X[Route publisher: xDS update + Redis route entry]
    X --&gt; Y{Production?}
    Y --&gt;|preview| Y1[Preview URL live]
    Y --&gt;|yes| Z[Traffic shift: canary → 100%&lt;br/&gt;Previous release drained]
    Z --&gt; AA[Deployment ACTIVE]</pre></figure>

## 4.2 Step-by-step, with failure handling

## Step 1 — Trigger and admission

**Inputs accepted:**
- Git webhook (push to tracked branch, PR opened/synchronized).
- `helix deploy` from CLI: creates a tarball of the working tree honoring `.helixignore`/`.gitignore`, uploads to a presigned S3 URL.
- Direct image reference (`helix deploy --image registry.example/foo@sha256:...`) — skips build entirely.

**Admission checks, all inside one transaction:**
- Caller has `deployment:create` on the project.
- Org is not suspended, is under its concurrent-build quota and its total-deployment quota.
- `helix.yaml` parses and validates against the schema ([§9](../09-universal-runtime-specification/)), including *resource ceilings the org's plan permits*.
- Idempotency: `(project_id, source_ref, config_hash, trigger_id)` — a re-delivered webhook does not create a second deployment.

**Failure modes:**

| Failure | Handling |
|---|---|
| Webhook replay / duplicate | Idempotency key → return existing deployment, `200` |
| Invalid `helix.yaml` | Fail fast at API time with a precise line/column error. Never create a build for a config that cannot run |
| Quota exceeded | `429` with quota detail; for git-triggered, post a failed commit status with the reason |
| Git provider unreachable | Deployment created as `QUEUED`, source fetch retried with backoff; after 5 attempts → `FAILED` with a clear message |

## Step 2 — Enqueue (transactional outbox)

**Problem.** "Insert deployment row" and "publish build job to NATS" must not diverge. If you `INSERT` then publish and crash between, the deployment hangs forever. If you publish then `INSERT` and crash, you build something that does not exist.

**Solution: transactional outbox.**

```sql
BEGIN;
  INSERT INTO deployments (...) VALUES (...) RETURNING id;
  INSERT INTO outbox (aggregate_id, topic, payload, created_at)
    VALUES ($1, 'builds.queue', $2, now());
COMMIT;
```

A relay goroutine (leader-elected, or per-replica with `FOR UPDATE SKIP LOCKED`) reads unpublished outbox rows, publishes to NATS, marks published. At-least-once; consumers are idempotent. A janitor also sweeps deployments stuck in `QUEUED` beyond a threshold and re-publishes, which covers relay bugs.

**[MVP simplification]:** you can skip NATS entirely at MVP and poll the `deployments` table with `SELECT ... FOR UPDATE SKIP LOCKED`. Postgres as a queue is perfectly adequate below ~1000 jobs/minute and removes a moving part. Introduce NATS in Phase 3.

## Step 3 — Build worker claim

A build worker pulls from the JetStream work queue with an explicit ack and a long ack-wait (equal to max build timeout + slack). Claiming writes `builds.state = RUNNING, builds.worker_id = ..., builds.lease_expires_at = now() + interval`.

**Failure modes:**

| Failure | Handling |
|---|---|
| Build worker dies mid-build | Lease expires → reaper transitions build to `QUEUED` with `attempt+1`; NATS redelivers. Max 2 automatic retries, and only for *infrastructure* failures — never for a build that failed because the user's code does not compile |
| Build worker hangs | Build timeout (default 15 min, max 60) enforced both in-VM (hard VM kill) and control-side (lease) |
| Duplicate delivery | `builds.attempt` + `ON CONFLICT` guard; the image is pushed to a digest-addressed location so a duplicate build is wasteful, not incorrect |

## Step 4 — Source acquisition

Inside the build VM (already isolated), fetch source:
- Git: `git clone --depth 1 --branch <ref>` using a **short-lived, read-only, repo-scoped token** minted per build (GitHub App installation token, ~1h). Never a long-lived PAT, never an org-wide token.
- Tarball: download from S3 presigned URL, extract with path traversal protection and a decompressed-size cap (zip bomb defense: cap at e.g. 2 GB uncompressed, `--no-same-owner`, reject symlinks pointing outside the tree).
- Submodules: opt-in only, and disabled by default (a malicious submodule URL is an SSRF vector).

## Step 5 — Build plan synthesis

The platform converts `helix.yaml` + the selected **Runtime Definition** into a BuildKit build.

Three modes:

| Mode | Trigger | Behavior |
|---|---|---|
| **Managed runtime** | `runtime.type: java` etc. | Platform-authored multi-stage Dockerfile template rendered from the runtime definition. User supplies only `build.command` and `run.command` |
| **Dockerfile** | `build.dockerfile: ./Dockerfile` | User's Dockerfile, built under the same sandbox and policy. Base image must pass policy ([§10.7](../10-custom-runtimes/#107-image-signing-and-admission)) |
| **Prebuilt image** | `image: registry/x@sha256:..` | No build; validate, re-sign, copy into internal registry |

Managed template (illustrative — this is data in `runtime-definitions/java/21.yaml`, not code):

```dockerfile
# syntax=docker/dockerfile:1.7
FROM ghcr.io/helix/build-java:21 AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=${CACHE_ID},target=/root/.m2,sharing=locked \
    --mount=type=secret,id=build_env,target=/run/secrets/build_env \
    set -a && . /run/secrets/build_env 2>/dev/null; set +a; \
    ${BUILD_COMMAND}

FROM ghcr.io/helix/run-java:21 AS run
WORKDIR /app
COPY --from=build /src/${OUTPUT_PATH} /app/
USER 65534:65534
ENV PORT=${PORT}
CMD ${RUN_COMMAND}
```

Note `sharing=locked` on the cache mount and `CACHE_ID` scoped per project ([§5.3](../05-build-system/#53-build-cache)) — sharing a cache across tenants is a cache-poisoning vulnerability.

## Step 6 — Build execution

See [§5](../05-build-system/) in full. Outputs: image pushed by digest, build log stream, cache export, exit status.

## Step 7 — Artifact hardening

Sequential, all failures block the release:
1. **SBOM** — `syft` over the final image → SPDX JSON → object storage, referenced by digest.
2. **Vulnerability scan** — `trivy`/`grype` against the image. Policy is **advisory by default, blocking on opt-in** (blocking by default makes the platform unusable — every Debian base has open CVEs). Critical+fixable vulns surface prominently in the UI.
3. **Signature** — `cosign sign` with a platform key (KMS-backed), plus an in-toto/SLSA provenance attestation recording: source repo + commit, build config hash, builder image digest, build start/end, and build VM identity.
4. **Admission policy** — the agent verifies the cosign signature before *ever* running an image. This is the control that stops "attacker with registry write access runs arbitrary images on the fleet."

## Step 8 — Release creation

An immutable `ReleaseSpec`, hashed and stored:

```json
{
  "release_id": "rel_01J8...",
  "project_id": "prj_...",
  "environment": "production",
  "image": "registry.helix.internal/org_x/prj_y@sha256:ab12...",
  "runtime": { "kind": "firecracker", "arch": "amd64" },
  "resources": { "vcpu": 1, "memory_mib": 512, "ephemeral_mib": 1024 },
  "command": ["java","-jar","/app/app.jar"],
  "http": { "port": 8080, "protocol": "http1" },
  "health": { "startup": {"path":"/healthz","timeout_s":60},
              "readiness": {"path":"/healthz","period_s":10} },
  "scaling": { "min": 0, "max": 10, "target_concurrency": 50 },
  "env_ref": "envset_01J8...",
  "secret_refs": ["sec_a","sec_b"],
  "spec_hash": "sha256:...",
  "created_at": "2026-09-13T04:00:00Z"
}
```

The spec references secrets, it does not contain them. Secrets are materialized at instance-start time and delivered over the agent's mTLS channel, never persisted to disk on the worker in plaintext.

## Step 9 — Scheduling and start

[§12](../12-serverless-scheduling/) covers the algorithm. Failure handling:

| Failure | Handling |
|---|---|
| No worker has capacity | Deployment waits in `SCHEDULING` with a deadline; triggers worker autoscaling ([§19.2](../19-autoscaling/#192-loop-2--worker-fleet)); fails after `scheduling_timeout` (default 5 min) |
| Image pull fails on worker | Retry 3× with backoff; then mark the *instance* failed, scheduler picks a different worker; 3 workers failing → deployment `FAILED` with the pull error surfaced |
| VM boots but startup probe never passes | Instance killed at `startup_timeout`; logs captured and shown to user (this is the #1 user-facing failure — the error message quality here is a product feature) |
| App crashes immediately (crashloop) | Exponential backoff on restart; after `max_start_failures` (default 3) the deployment fails. **Crucially, traffic is never shifted** — the previous release keeps serving |

## Step 10 — Traffic shift

Only after `min(ready_instances) ≥ required_ready`:

- <span class="mat mat-mvp">MVP</span> Atomic switch: alias `production` → new release; old release drained after `drain_timeout`.
- <span class="mat mat-v1">V1</span> Canary: 5% → 25% → 100% with automatic rollback on error-rate or latency regression measured at the gateway over a sliding window. Weighted routing is a route-table weight, evaluated in the gateway.
- Old release instances go to `DRAINING`: removed from new-request routing, existing requests allowed to finish, then stopped. For scale-to-zero releases, previous release keeps its snapshot cached for `rollback_window` (default 24h) so rollback is instant.

**Failure:** if the shift is partially applied (some gateways updated, some not), that is *acceptable* — both releases are healthy and serving. The route table is versioned with a monotonic generation number; gateways apply only higher generations, so the system converges and never flaps backwards.

## 4.3 Deployment state machine

See [§38.8](../38-distributed-systems-concerns/#388-deployment-state-machine) for the complete machine including failure states. Summary path:

```text
QUEUED → BUILDING → BUILT → SCHEDULING → STARTING → READY → ACTIVE → SUPERSEDED → STOPPED
```

## 4.4 What happens to the old version

Nothing destructive, for `rollback_window`:
- The image stays in the registry (GC excludes any image referenced by a release younger than the retention window, or referenced by any alias).
- The `ReleaseSpec` row stays.
- The Firecracker snapshot, if any, stays in the worker's snapshot cache and in object storage.

This is what makes rollback a routing change rather than a rebuild.

## 4.5 Rollback

```text
POST /v1/projects/{id}/rollback   { "to_release": "rel_abc", "environment": "production" }
```

1. Validate the target release exists, belongs to the project/environment, and its image digest is still present in the registry.
2. If the target has ≥1 ready instance (common within the drain window) → **routing change only**, sub-second.
3. Otherwise → schedule instances from the stored `ReleaseSpec` (no rebuild, no config re-resolution), wait for health, then shift.
4. Emit an audit event, post commit status back to git, notify.

**Important subtlety: environment variables.** If the user changed an env var between releases, does rollback restore the old env? Options: (a) pin env to the release (fully immutable, surprising when rolling back also reverts a fixed API key), (b) always use current env (surprising when the old code cannot handle the new env). **Decision: pin the *env set version* to the release, but display a prominent diff at rollback time and allow `--use-current-env`.** Silent divergence here causes real outages; make it explicit.

## 4.6 Failure scenario catalogue for the pipeline

| Scenario | Detection | Response | Data loss risk |
|---|---|---|---|
| Control plane dies between `QUEUED` and enqueue | Janitor sweeps stale `QUEUED` | Re-publish from outbox | None |
| Build worker OOM | cgroup OOM event, exit 137 | Surface "build exceeded memory limit" (not a generic crash); do not auto-retry | None |
| Registry unavailable during push | Push error | Retry with backoff; build result cached locally for up to 10 min so retry does not rebuild | None |
| Registry unavailable during pull on worker | Pull error | Use local cache if digest present; else try peer workers ([§13.4](../13-cold-start-optimization/#134-strategy-3--image-and-filesystem-caching)); else fail instance | None |
| Scheduler leader lost mid-deployment | Lease expiry | New leader reads deployment rows and resumes; transitions are idempotent | None |
| Agent dies after VM start but before report | Missing report | On reconnect, agent adopts and reports; control plane reconciles | Brief route staleness |
| Two orchestrator replicas process the same deployment | — | Prevented by `SELECT ... FOR UPDATE` on the deployment row + state guards in the `UPDATE ... WHERE state = expected` | None |
| Network partition between control plane and a worker | Heartbeat loss | Worker fenced after 60s; instances presumed unhealthy and removed from routing; **worker self-fences** by stopping instances if it cannot reach control for >5 min (prevents split-brain double-serving) | In-flight requests |
