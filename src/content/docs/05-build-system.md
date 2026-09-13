---
title: "5. Build System"
description: "Secure multi-tenant builds: isolation, cache, secrets, egress policy, and the malicious-build attack tree."
sidebar:
  order: 5
---

This is the most commonly under-secured part of a deployment platform, because it *feels* like CI rather than like running untrusted code. It is running untrusted code, with network access, with credentials nearby, at high privilege.

## 5.1 Build isolation: the core decision

**Problem.** A customer's `RUN` line executes arbitrary commands. BuildKit's default execution uses containers (namespaces + seccomp). Is that enough?

**Candidates.**

| Option | Isolation strength | Performance | Notes |
|---|---|---|---|
| A. Shared BuildKit daemon, container isolation, multi-tenant | Weak | Best (shared cache, no boot) | One container escape or one BuildKit bug = full daemon compromise = all tenants' source, caches, and registry credentials. **Rejected.** |
| B. BuildKit rootless, one daemon per build, container isolation | Medium | Good | Rootless removes a lot of escape surface but still shares the host kernel. A kernel LPE in the build container is game over |
| C. **BuildKit inside a per-build Firecracker microVM** | Strong | ~1–2 s VM boot overhead + cache warm-up | Same isolation primitive as the runtime. Build VM is disposable |
| D. Per-build dedicated bare-metal host | Strongest | Terrible utilization | Only for enterprise "dedicated build" tier |

**Decision: Option C. One Firecracker microVM per build, destroyed after. <span class="mat mat-v1">V1</span> — Option B is acceptable for <span class="mat mat-mvp">MVP</span> single-tenant/self-serve-off.**

Rationale: the build environment executes untrusted code with *more* capability than the runtime (network egress to package registries, large disk, long duration). It deserves *at least* the runtime's isolation. Using the same primitive also means you build and harden one sandbox, not two.

**Tradeoffs.**
- Build cache must live outside the VM and be attached per build → a cache volume (block device) mounted into the build VM, snapshotted/restored per project.
- +1–3 s per build for VM lifecycle and cache attach. Irrelevant against a 90 s Maven build; noticeable against a 3 s Go build. Mitigate with a warm build-VM pool ([§13.2](../13-cold-start-optimization/#132-strategy-1--warm-pools)), same mechanism as runtime warm pools.
- The build VM needs a larger, more capable rootfs (git, BuildKit, package tools) — a bigger attack surface *inside* the VM, but the VM boundary is what matters.

**Operational implication.** Build workers are physically separate hosts from runtime workers. They have different disk profiles (huge NVMe for cache), different network policy (must reach npm/PyPI/Maven Central; must *not* reach the control plane DB or other tenants), and different scaling (bursty).

## 5.2 Build sandbox layers

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph HOST[&quot;Build Worker Host&quot;]
        BA[helix-builder agent]
        subgraph VM[&quot;Firecracker build microVM (per build)&quot;]
            direction TB
            INIT[vminit]
            BK[buildkitd rootless]
            subgraph EXEC[&quot;RUN step execution&quot;]
                UC[Untrusted build commands]
            end
            BK --&gt; EXEC
        end
        CACHEV[(Per-project cache block device)]
        PROXY[Egress proxy: allowlist, TLS MITM optional, audit log]
    end
    BA --&gt; VM
    VM --&gt;|virtio-blk| CACHEV
    VM --&gt;|only route out| PROXY
    PROXY --&gt;|HTTPS| INET[npm / PyPI / Maven / crates.io / GitHub]
    BA --&gt;|push, scoped token| REG[(Internal Registry)]
    style EXEC fill:#7f1d1d,color:#fff</pre></figure>

Layers, outermost first:
1. **Firecracker + KVM** — hardware virtualization boundary.
2. **jailer** — chroot, unprivileged uid/gid, cgroup, netns, seccomp on the VMM.
3. **Network namespace + nftables** — the build VM's *only* egress route is the local egress proxy. No direct internet.
4. **Egress proxy** — HTTP CONNECT proxy with a domain allowlist, per-build audit log, bandwidth cap. Denies by default.
5. **cgroup limits** — CPU, memory, I/O, and a hard wall-clock timeout.
6. **Rootless BuildKit inside the guest** — defense in depth; a BuildKit escape lands you in an unprivileged guest process, not guest root.
7. **No credentials in the VM** — the registry push happens *outside* the VM, by the builder agent, from an exported image tarball/OCI layout. The build VM never holds a registry credential.

That last point deserves emphasis. **The single highest-value target for a malicious build is your registry credential.** If the build VM can push arbitrary images, an attacker can overwrite another tenant's image (if scoping is wrong) or plant a backdoored base image. Architecture: BuildKit exports to a local OCI layout on the cache device; the builder agent, outside the VM, reads that layout, validates it (size, layer count, no absurd whiteouts), and pushes with a **single-use token scoped to exactly `org_x/prj_y` and exactly this digest namespace**.

## 5.3 Build cache

**Problem.** Without cache, every Maven/npm/cargo build re-downloads the world. With a naive shared cache, tenant A poisons tenant B.

**Design:**

| Cache layer | Scope | Backing | Eviction |
|---|---|---|---|
| BuildKit layer cache (LLB results) | **Per project** | Registry-backed cache export (`type=registry,ref=.../cache:prj_y`) or a per-project block device | LRU by project, 30-day TTL, size cap per plan |
| Package manager cache (`~/.m2`, `~/.npm`, `~/.cargo`, `pip`) | **Per project** | Block device attached at `/cache`, mounted as BuildKit cache mounts | Size cap; user can `helix cache purge` |
| Upstream package mirror | **Global, read-only, platform-controlled** | Pull-through proxy (Artifactory/Nexus/`verdaccio`/`devpi` or just a caching HTTP proxy) | Standard |
| Base image layers | **Global, platform-controlled** | Registry + worker local blob cache | LRU |

**The hard rule:** the only *shared* caches are ones the platform writes and tenants can only read. Anything a tenant's build can write is scoped to that project.

**Why per-project rather than per-org?** Two projects in an org usually have unrelated dependency trees, and per-project scoping also contains damage if one repo is compromised. Per-org sharing is an optional optimization users can enable.

**Concurrency:** `sharing=locked` on cache mounts serializes concurrent builds of the same project against the same cache. Alternative `sharing=shared` risks corrupting e.g. the Maven local repo. Accept the serialization; it is correct.

## 5.4 Build secrets

Requirements: available during build, never in the image, never in logs, never on disk after build.

- Delivered via BuildKit `--secret` → mounted as a tmpfs file at `/run/secrets/<id>` for the duration of a single `RUN`. Never `ARG`/`ENV` (those land in image history, which is readable by anyone who can pull the image).
- The secret set for a build is decrypted by the control plane, sent to the builder agent over mTLS, held in memory, and passed to BuildKit's secret provider over a local socket. Never written to the build VM's persistent disk.
- **Log redaction:** the builder agent maintains the set of secret *values* for the build and scrubs them from the log stream before shipping. This is imperfect (base64, split across lines) but catches the common accidental `echo $TOKEN`. Document that it is best-effort.
- Build secrets and runtime secrets are **separate sets**. A `DATABASE_URL` should not be present at build time; an `NPM_TOKEN` should not be present at runtime.

## 5.5 Network access during build

**Problem.** Builds need `npm install`. Unrestricted egress means your build fleet is a free proxy, a spam relay, a port scanner, and an SSRF launchpad into your own VPC.

**Policy <span class="mat mat-v1">V1</span>:**

| Destination | Default |
|---|---|
| Known package ecosystems (registry.npmjs.org, pypi.org + files.pythonhosted.org, repo.maven.apache.org, crates.io + static.crates.io, proxy.golang.org, rubygems.org, packagist.org, nuget.org, hex.pm, pub.dev, apt/deb & rpm mirrors, Docker Hub/GHCR for base images) | **Allow** via egress proxy |
| github.com / gitlab.com / bitbucket.org (HTTPS, for git deps) | **Allow** |
| Everything else | **Deny**, with a clear build-log message naming the blocked host |
| RFC1918, link-local `169.254.0.0/16`, platform VPC ranges, cloud metadata | **Deny always, no override** |
| Outbound SMTP (25/465/587), IRC, common C2 ports | **Deny always** |
| Inbound connections | **Deny** — the build VM has no inbound path at all |

Users can request additional allowlist entries per project (self-serve with review, or auto-approve well-known hosts). Offer `build.network: none` for fully vendored builds, which is both faster and more secure, and reward it in the UI.

**Operational note:** run your own pull-through mirrors for the top ecosystems. It cuts build time substantially, removes a dependency on npm's availability, and gives you a natural place to enforce policy and detect dependency-confusion attacks.

## 5.6 Resource limits

| Limit | Default | Max (plan-dependent) | Enforcement |
|---|---|---|---|
| vCPU | 2 | 16 | VM config + `cpu.max` |
| Memory | 4 GiB | 32 GiB | VM memory size (hard — guest OOM kills the build, reported clearly) |
| Disk (workspace) | 20 GiB | 100 GiB | Sized block device |
| Disk (cache) | 10 GiB | 50 GiB | Sized block device, enforced at attach |
| Wall clock | 15 min | 60 min | In-VM watchdog **and** host-side kill |
| Egress bandwidth | 100 Mbit | 1 Gbit | `tc` on the TAP |
| Egress bytes total | 10 GiB | 50 GiB | Proxy accounting; kill on exceed |
| Log output | 50 MB | 200 MB | Truncate with marker |
| Concurrent builds per org | 2 | 20 | Control-plane admission |
| Max image size | 2 GiB | 10 GiB | Checked post-build before push |

Every limit produces a **specific, actionable error message**. "Build failed" is a product defect.

## 5.7 Build logs

- `vminit` in the build VM forwards BuildKit's output over vsock, framed with `(step_id, stream, ts, bytes)`.
- Builder agent streams to: (a) NATS subject `logs.build.{build_id}` for live tailing by the CLI/dashboard, and (b) batched to Loki/object storage for retention.
- Live tail: CLI opens `GET /v1/builds/{id}/logs?follow=true` (SSE or WebSocket), control plane subscribes to the NATS subject and relays. Backfill from Loki for the portion already elapsed, then switch to live — with a sequence number so the handoff does not duplicate or drop lines.
- Retention: 30 days hot (Loki), then object storage; logs for failed builds retained longer by default because that is when people look.

## 5.8 Cancellation

`POST /v1/builds/{id}/cancel` →
1. Set `builds.cancel_requested = true` (this is the durable signal).
2. Publish `builds.cancel.{build_id}` on NATS.
3. Builder agent receives it, sends `SendCtrlAltDel` then kills the VM, marks `CANCELLED`.
4. If the agent never receives it, the periodic reconcile (agent polls its active builds' cancel flags every 2 s) catches it. **Never rely solely on a pub/sub message for cancellation** — always have a pulled signal as backstop.
5. Partial artifacts are discarded; cache exports from a cancelled build are *not* committed (a cancelled build's cache may be inconsistent).

## 5.9 Retries and reproducibility

**Retry policy.** Distinguish rigorously:

| Class | Examples | Auto-retry? |
|---|---|---|
| Infrastructure | VM failed to boot, worker died, registry 5xx, proxy error | Yes, up to 2, different worker |
| Transient external | npm 503, git timeout | Yes, 1 retry, with backoff |
| User error | compile error, test failure, missing file, OOM from user's own build | **No.** Retrying wastes money and confuses users |

Distinguish by exit code and by structured error from the builder, not by string matching on logs.

**Reproducibility.** Full bit-for-bit reproducibility is not a realistic V1 goal (timestamps, dependency resolution drift, non-deterministic compilers). Aim for **verifiable provenance** instead, which is what actually delivers the security value:

- Pin the builder image by digest in the runtime definition.
- Record in SLSA provenance: source commit, `helix.yaml` hash, builder image digest, resolved runtime definition version, all build args.
- Set `SOURCE_DATE_EPOCH` and normalize timestamps where the toolchain honors it.
- Encourage (and, for managed runtimes, require) lockfiles. Warn loudly when a build has no lockfile — it is both non-reproducible and a supply-chain risk.

Offer opt-in "strict reproducible" mode later that uses a fully vendored dependency snapshot and `build.network: none`.

## 5.10 Artifact storage and the registry

**Decision: run your own OCI registry. <span class="mat mat-mvp">MVP</span>**

| Option | Assessment |
|---|---|
| **CNCF Distribution** (`registry:3`) | Reference implementation, S3 backend, simple, battle-tested. **Choose this for MVP/V1.** |
| **Zot** | OCI-native, built-in cosign/notation verification, sync, good for edge/regional mirrors. Strong candidate at V1 for regional replicas |
| Harbor | Full product: RBAC, scanning, replication, quotas — but heavyweight (Postgres + Redis + several services) and its RBAC will fight yours |
| Cloud registry (ECR/GCR) | Fast start, but per-tenant scoping, egress cost, and cross-cloud portability become problems. Also you want *your* auth model |

Layout: `registry.helix.internal/{org_slug}/{project_slug}@sha256:...`. Always reference by digest. Tags exist only for human convenience and are never used for scheduling.

**GC:** an image is retained if referenced by any release that is (a) currently routed, (b) within `rollback_window`, or (c) the N most recent releases of the project. Mark-and-sweep runs off-peak with a safety delay; never delete a blob referenced in the last 24h.

**Storage:** S3-compatible. Use MinIO on your own disks if you are on bare metal ([§33](../33-cost-model/)), or the cloud provider's S3. Registry metadata in Postgres (Distribution can use S3 alone; for scale and for GC sanity, prefer a metadata DB).

## 5.11 Attack tree: malicious build

<figure class="mermaid-figure"><pre class="mermaid">graph TD
    G[&quot;GOAL: compromise the platform via a build&quot;] --&gt; A1[Escape the build sandbox]
    G --&gt; A2[Steal credentials]
    G --&gt; A3[Poison artifacts]
    G --&gt; A4[Abuse resources]
    G --&gt; A5[Attack the network]
    A1 --&gt; A1a[Kernel LPE in guest → guest root]
    A1 --&gt; A1b[Firecracker/virtio device 0-day → host]
    A1 --&gt; A1c[BuildKit daemon vuln → daemon privileges]
    A1 --&gt; A1d[Escape via shared mount / cache device]
    A2 --&gt; A2a[Read registry push credential]
    A2 --&gt; A2b[Read another tenant&#x27;s build secret from shared cache]
    A2 --&gt; A2c[Query cloud metadata service for host IAM role]
    A2 --&gt; A2d[Read git token and pivot to the customer&#x27;s other repos]
    A3 --&gt; A3a[Write into a shared cache consumed by another tenant]
    A3 --&gt; A3b[Push an image outside own namespace]
    A3 --&gt; A3c[Dependency confusion via internal package names]
    A3 --&gt; A3d[Tamper with SBOM/provenance]
    A4 --&gt; A4a[Crypto mining during long build]
    A4 --&gt; A4b[Fork bomb / disk fill to DoS the worker]
    A4 --&gt; A4c[Infinite build to hold capacity]
    A5 --&gt; A5a[Scan platform internal network]
    A5 --&gt; A5b[SSRF to control plane / DB / metadata]
    A5 --&gt; A5c[Use build fleet as spam or DDoS source]
    A5 --&gt; A5d[Exfiltrate stolen data over DNS]
    style G fill:#7f1d1d,color:#fff</pre></figure>

**Mitigations, mapped:**

| Attack | Mitigation |
|---|---|
| A1a guest kernel LPE | Assume it succeeds. Guest root is still inside the VM. This is exactly why builds run in a VM, not a container |
| A1b Firecracker 0-day | Minimal device model; jailer (chroot + unpriv uid + seccomp); host kernel hardened and patched; build workers physically separate from runtime workers so a build escape does not reach customer runtime data; per-host blast radius accepted and monitored |
| A1c BuildKit vuln | Rootless BuildKit; BuildKit is *inside* the VM so a full compromise still yields only the VM |
| A1d shared mounts | Only the per-project cache device is attached; no host paths bind-mounted into the build VM; cache device is a block device (not a shared filesystem) so no cross-VM concurrent mount |
| A2a registry credential | **Not present in the VM.** Push happens outside, from an exported OCI layout, with a single-use scoped token |
| A2b other tenants' secrets | Caches are per-project; VM is destroyed after; no shared tmp |
| A2c metadata service | nftables drops `169.254.0.0/16` unconditionally; build workers run with **no cloud instance IAM role** (or IMDSv2 with hop-limit 1 and an empty role); credentials come from the control plane over mTLS instead |
| A2d git token | Token is repo-scoped, read-only, ~1h TTL, minted per build |
| A3a cache poisoning | Per-project caches only; platform-global caches are read-only to builds |
| A3b out-of-namespace push | Push is done by the agent with a token scoped to one repository path; registry enforces path scoping independently |
| A3c dependency confusion | Pull-through mirror with an explicit policy: internal package namespaces are never resolved from public registries; warn on newly-appearing public packages matching internal names |
| A3d provenance tampering | SBOM/scan/sign are computed **outside** the build VM by the builder agent over the exported artifact |
| A4a mining | CPU is metered and billed; anomaly detection on sustained 100% CPU with near-zero egress-to-package-registries and low disk write ([§24.2](../24-abuse-prevention/#242-detection-signals)); build timeout caps it |
| A4b fork bomb / disk fill | Guest cgroup `pids.max`, fixed VM memory, fixed-size disks; host is unaffected because all resources are VM-scoped |
| A4c infinite build | Hard wall-clock timeout, both in-VM and host-side |
| A5a/b network scanning & SSRF | Only route out is the egress proxy; proxy denies non-allowlisted hosts and all RFC1918/link-local; no inbound path; conntrack limits |
| A5c spam/DDoS | SMTP ports blocked; bandwidth and total-bytes caps; egress destination anomaly detection; per-org reputation scoring |
| A5d DNS exfiltration | DNS resolution goes through a platform resolver that only answers allowlisted domains, logs QPS, and rate-limits; raw UDP/53 egress blocked |

**Residual risks you must accept and monitor:** a Firecracker or KVM 0-day; CPU microarchitectural side channels between concurrent builds on the same physical core (mitigate with core scheduling / SMT policy, [§6.6](../06-runtime-isolation-and-threat-model/#66-cpu-side-channels-and-smt-policy)); a compromised upstream package (this is the customer's supply chain, but your SBOM makes it detectable); and an insider with registry write access (mitigate with signing + admission).
