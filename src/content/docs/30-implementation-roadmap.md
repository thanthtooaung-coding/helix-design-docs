---
title: "30. Implementation Roadmap"
description: "Eight phases with goals, tasks, acceptance criteria, risks, and realistic timelines."
sidebar:
  order: 30
---

## 30.0 How to read this

Durations assume **one experienced full-time engineer** for Phases 0–2 and a small team (3–6) thereafter. They are calendar estimates with normal interruptions, not ideal-world estimates. If you are part-time, multiply by 2.5–3.

The ordering rule: **each phase must end with something demonstrable and, where possible, usable**. Do not build the scheduler before you can boot one VM by hand.

---

## Phase 0 — Foundations and local development (2–4 weeks)

**Goal.** A Linux environment where you can boot a Firecracker microVM from an OCI image by hand, with a script, and understand every step.

**Components.** None of the platform yet. Tooling only.

**Tasks.**
1. Set up the development environment ([§31](../31-local-development-environment/)). Get `/dev/kvm` working and verified.
2. Build a minimal guest kernel from source with the microVM config. Boot it with a busybox initrd. Time it.
3. Write `tools/rootfs-builder`: pull an OCI image with `crane`/`skopeo`, flatten, `mkfs.ext4 -d`. Start in a shell script; port to Rust later.
4. Boot Firecracker manually: kernel + rootfs + tap, run `nginx` or a Go hello-world inside, `curl` it from the host.
5. Add `jailer`. Confirm the process is unprivileged and chrooted.
6. Write `vminit` v0 in Rust: mount `/proc`, exec a command, forward stdout over vsock. Host side prints it.
7. Set up the repo skeleton, `docker-compose.dev.yaml` (Postgres, Redis, registry, MinIO), Makefile, CI with lint+test.
8. Write ADR-0001 (OCI as artifact) and ADR-0002 (Firecracker for isolation).

**Dependencies.** Hardware/VM with nested virtualization or bare metal.

**Acceptance criteria.**
- `make vm-demo IMAGE=nginx:alpine` boots a jailed microVM and serves HTTP on a host port, in under 1 second, reproducibly.
- Guest logs appear on the host via vsock.
- You can explain every file in the jail directory.

**Risks.**
- *Nested virtualization unavailable or flaky.* → Rent a bare-metal box early ([§31](../31-local-development-environment/)). This is the most common Phase 0 blocker and it wastes weeks if unresolved.
- *Kernel config rabbit hole.* → Start from Firecracker's published microVM config; do not optimize yet.

---

## Phase 1 — Single-node MVP: git → build → OCI → Firecracker → HTTP (6–10 weeks)

**Goal.** `helix deploy` on a Go/Node app produces a live URL, on one machine, for one user (you).

**Components.** `helix-control` (minimal), `helix-agent` (minimal), `vminit`, `cli`, local registry, one runtime definition.

**Tasks.**
1. Postgres schema for: users, orgs, projects, environments, deployments, builds, images, releases, instances, workers. Migrations tooling.
2. `helix-control`: auth with a single hardcoded user + PAT; `POST /deployments`; deployment state machine with Postgres as the queue (`FOR UPDATE SKIP LOCKED`) — **no NATS yet**.
3. Build path: BuildKit in a container (not a VM yet — accept the security debt, document it, and **do not expose this to any third party**). Render Dockerfile from a runtime definition. Push to the local registry.
4. `helix-agent` in Rust: gRPC session with control, image pull + rootfs build, network setup, jailer + Firecracker boot, vsock logs, TCP health check, instance report.
5. Routing: a single Go reverse proxy (not Envoy yet) that maps `Host` → instance. Hardcoded wildcard DNS to your dev box.
6. CLI: `login`, `init`, `deploy`, `logs`, `status`.
7. Two runtime definitions: `go` and `node`. Prove the extensibility claim by adding the second one without touching Go/Rust code.
8. Logs: agent → Postgres or a file, tailed by the CLI. Loki comes later.

**Dependencies.** Phase 0.

**Acceptance criteria.**
- From a clean repo: `helix init && helix deploy` → URL serving traffic in < 90 s.
- `helix logs --follow` shows app output live.
- Killing the app process causes a restart; killing the agent does not kill running VMs.
- Adding a third runtime (Python) takes < 1 hour and touches only `runtime-definitions/`.

**Risks.**
- *Scope creep into Phase 2 features.* → Explicitly defer: no multi-tenancy, no TLS, no autoscaling, no scale-to-zero, no snapshots.
- *Rootfs conversion is slower than expected for big images.* → Accept for now; caching comes in Phase 4.

---

## Phase 2 — Multi-tenant, secure, publicly usable by a few people (10–16 weeks)

**Goal.** You could let a friend deploy to it without lying awake.

**Components.** Full auth/authz, secrets, build isolation in VMs, Envoy, TLS, domains, quotas, audit, observability.

**Tasks.**
1. Orgs, memberships, RBAC, PATs, sessions, MFA. **RLS on every tenant table** plus the cross-tenant test suite.
2. Secrets: KMS integration (or Vault), envelope encryption, delivery to `vminit` over vsock.
3. **Move builds into Firecracker microVMs.** Build VM rootfs with BuildKit, cache block device, egress proxy with the allowlist, resource limits, timeouts, cancellation.
4. Network isolation: per-VM netns, nftables policy (metadata blocked, RFC1918 blocked, port blocks), egress NAT, `tc` rate limits.
5. Guest hardening: minimal kernel, seccomp in `vminit`, non-root user, read-only rootfs, size-capped overlay and tmpfs.
6. Envoy at the edge + xDS server; ACME for `*.helix.app`; custom domain verification + per-domain certs.
7. Quotas and rate limits; billing-less metering (collect usage, do not charge yet).
8. Observability: Prometheus + Grafana + Loki; the four SLOs; the deployment trace.
9. Audit log; abuse basics (signup verification, egress caps, CPU anomaly alerting).
10. Runtime definitions for Java, Python, Ruby, PHP, .NET.
11. Dashboard v1: deployments, logs, env/secrets, domains.
12. `test/security/`: automated escape attempts.

**Dependencies.** Phase 1.

**Acceptance criteria.**
- A security review ([§39](../39-production-security-review/)) has been performed and its critical findings closed.
- A deliberately malicious test image cannot: reach 169.254.169.254, reach the control plane, read another tenant's data, exhaust the host, or push to another tenant's registry namespace.
- Two orgs cannot see each other's anything — verified by automated test.
- TLS works for a custom domain end to end, with automatic renewal.
- Cross-tenant RLS test suite passes.

**Risks.**
- *Build-in-VM is harder than expected* (cache devices, BuildKit in a guest, performance). → This is the biggest single chunk of Phase 2. Budget 4 weeks alone. Fallback: rootless BuildKit in a hardened container with strict egress control, shipped **only** to invited users, with the VM version as a fast follow.
- *Secrets design gets rewritten.* → Get [§23.4](../23-security-architecture/#234-secrets-management) right the first time; retrofitting envelope encryption is painful.

---

## Phase 3 — Multiple workers (6–8 weeks)

**Goal.** Horizontal compute. Instances placed across a fleet; worker failure is survivable.

**Components.** Scheduler with placement, worker registration/lifecycle, NATS, route publisher, gateway as a separate service.

**Tasks.**
1. Worker registration, heartbeats, mTLS identity, capacity reporting, fencing generation.
2. Placement engine ([§12.3](../12-serverless-scheduling/#123-placement-algorithm)) with reservations; leader election via Postgres advisory lock.
3. Reconciliation loop: desired vs actual, orphan detection, replacement on worker failure.
4. Introduce NATS: build queue, telemetry, cancellation, usage events. Keep the Postgres outbox.
5. Split `helix-gateway` out; route table via Redis + gRPC; two-tier xDS design ([§11.3](../11-http-routing/#113-route-table-and-propagation)).
6. Worker provisioning automation (Packer + Ansible/Terraform); cordon/drain; agent upgrade without draining.
7. Zone-aware spread; per-org per-worker caps.
8. Chaos test: kill a worker under load, verify recovery and request loss bounds.

**Acceptance criteria.**
- 3+ workers; killing one during a load test causes < 1% request errors and full recovery within 60 s.
- Deploying a 20-instance app spreads across workers and zones.
- Agent upgrade is a rolling `systemctl restart` with no instance restarts.

**Risks.** *Split-brain and duplicate instances.* → Implement fencing tokens and the self-fence timeout in this phase, not later.

---

## Phase 4 — Autoscaling, scale-to-zero, cold-start optimization (8–12 weeks)

**Goal.** The serverless value proposition actually works.

**Tasks.**
1. Concurrency metrics from the gateway → autoscaler; stable/panic windows; min/max instances.
2. Activator: single-flight, queueing, cold-start budget, progressive scale-up.
3. Scale-to-zero with anti-flap.
4. Image caching: worker blob + rootfs cache with LRU; prefetch on release creation; peer-to-peer layer fetch.
5. **Firecracker snapshots**: create after warmup, UFFD restore, CPU templates, post-restore hooks (entropy, clock, app notification), encryption, storage lifecycle.
6. Warm pools if measurement justifies them.
7. Language-specific startup optimizations in runtime definitions (AppCDS, `.pyc`, bootsnap, bundling).
8. Cold-start dashboard per runtime; a "your cold start could be X" recommendation in the UI.
9. Worker fleet autoscaling (Loop 2) with a hot-spare pool.

**Acceptance criteria.**
- Spring Boot cold start p95 < 300 ms with snapshots (from ~4 s without).
- 500 simultaneous requests to a cold app cause exactly one cold start.
- Scale 0 → 20 instances under load in < 15 s.
- **Snapshot entropy test passes:** 100 VMs restored from one snapshot produce 100 distinct UUIDs and distinct TLS session keys.

**Risks.**
- *Snapshot correctness bugs are subtle and security-relevant.* → Write the entropy/clock tests before the feature is considered done.
- *CPU template mismatches cause guest crashes on heterogeneous hardware.* → Standardize CPU templates across the fleet in this phase.

---

## Phase 5 — WASM runtime (6–10 weeks)

**Goal.** A second execution path for dense, tiny, fast workloads.

**Tasks.**
1. `wasm-host` in Rust: Wasmtime, pooling allocator, epoch interruption, store limits, `wasi:http` handler.
2. Build path: compile source → component → `wasmtime compile` → `.cwasm`, sign, store. Wizer pre-initialization.
3. Runtime definitions for Rust/Go/JS wasm targets; the `helix-http` WIT world.
4. Agent integration: per-tenant host processes, instance pooling, routing from the gateway.
5. Recompilation pipeline for Wasmtime upgrades.
6. Dogfood: move gateway edge middleware to wasm.

**Acceptance criteria.** Sub-5 ms cold start p99; 5000+ instances of distinct tenants on one worker; a Wasmtime upgrade recompiles and rolls out without downtime.

**Risks.** *Ecosystem churn in WASI/component model.* → Pin versions; expect breaking changes; keep the WIT world small.

---

## Phase 6 — Multiple regions (8–12 weeks)

**Tasks.** Regional Postgres replicas; regional NATS with gateways; registry mirrors; regional Envoy + gateway + scheduler; GeoDNS then anycast; data-residency flags; cross-region failover runbook and game day; latency-aware routing; per-region capacity planning.

**Acceptance criteria.** A full region can be taken offline during a game day with < 5 min of degraded service and no data loss; a deployment can target multiple regions and roll out to all of them.

**Risks.** *Cross-region Postgres write latency degrades the deploy experience.* → Measure early; consider a regional read-replica-plus-write-forwarding pattern; revisit distributed SQL only if it is genuinely a problem.

---

## Phase 7 — Production hardening (continuous, 12+ weeks of focused effort)

**Tasks.** External penetration test and a Firecracker-focused escape assessment; SOC 2 groundwork; full DR rehearsal; abuse-detection ML/heuristics and a human review queue; billing integration and reconciliation; spending limits; status page and incident process; on-call rotation and runbooks for every alert; load testing to 10× expected peak; performance profiling of the agent and gateway; documentation; support tooling (impersonation with audit, customer-visible incident timeline).

**Acceptance criteria.** The [§42](../42-production-readiness-checklist/) production readiness checklist is fully green.

---

## 30.1 Timeline summary

| Phase | Solo (elapsed) | Small team (3–6) |
|---|---|---|
| 0 Foundations | 3 weeks | 2 weeks |
| 1 Single-node MVP | 8 weeks | 4 weeks |
| 2 Multi-tenant + security | 14 weeks | 7 weeks |
| 3 Multiple workers | 7 weeks | 4 weeks |
| 4 Autoscaling + cold start | 10 weeks | 6 weeks |
| 5 WASM | 8 weeks | 4 weeks |
| 6 Multi-region | 10 weeks | 6 weeks |
| 7 Hardening | ongoing | ongoing |
| **To a defensible public beta (0–4)** | **~10 months** | **~5–6 months** |
| **To production v1 (0–7)** | **~18–24 months** | **~12–15 months** |

An honest note: solo, the realistic path is Phases 0–2 to a working demo you show people, then hire or partner. Phase 2's security work alone is where a solo project either becomes serious or quietly becomes a toy — and running strangers' code without it is a liability, not a product.
