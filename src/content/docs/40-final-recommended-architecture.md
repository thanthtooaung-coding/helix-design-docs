---
title: "40. Final Recommended Architecture"
description: "The concise final stack, how it balances the five constraints, and the decisions most likely to be regretted."
sidebar:
  order: 40
---

## 40.1 The one-paragraph version

Package everything as **OCI images** built by **BuildKit** inside **per-build Firecracker microVMs**; store them in your own **OCI registry** on **S3-compatible object storage**, signed with **cosign** and accompanied by an SBOM. Run them as **Firecracker microVMs** managed by a small **Rust agent** on **bare-metal Linux workers**, with a Rust **`vminit`** as guest PID 1, per-VM network namespaces and **nftables** policy, and **snapshots** for fast cold starts. Offer **Wasmtime** as a separate, opt-in runtime for tiny, dense, sub-millisecond workloads. Control it all with a **Go modular monolith** on **PostgreSQL** (source of truth) plus **Redis** (caches and coordination) and **NATS JetStream** (work queue and telemetry), fed by a **transactional outbox**. Route traffic through **Envoy** at the edge with a **Go gateway/activator** behind it that holds requests during cold starts. Observe with **Prometheus, Loki, Tempo and OpenTelemetry**. Build it in the order given in [§30](../30-implementation-roadmap/), and do not open self-serve signup until the gates in [§39.6](../39-production-security-review/#396-recommended-gates-before-untrusted-signup) are green.

## 40.2 The stack, with every deviation from the brief justified

| Layer | Choice | Deviation from the brief? |
|---|---|---|
| Control plane | **Go**, modular monolith, 1 binary | No — but explicitly *not* microservices |
| Agent / guest init / wasm host | **Rust** | No |
| Isolation | **Firecracker + KVM + jailer + seccomp + netns + cgroups v2 + nftables** | No |
| Second runtime | **Wasmtime**, separate deployment type | Clarified: not an automatic optimization |
| Packaging | **OCI image + BuildKit + own registry** | No |
| Database | **PostgreSQL 16+** with RLS, partitioning, outbox | No |
| Cache/coordination | **Redis** (or Valkey) | No |
| Messaging | **NATS JetStream** — *and Postgres-as-queue for the MVP* | Refined: do not deploy NATS in Phase 1 |
| Edge proxy | **Envoy** + **Go activator** | Refined: Envoy alone cannot do scale-to-zero; the activator is a required component |
| Object storage | **S3 API**; Cloudflare R2 or self-hosted MinIO | Refined: R2's zero egress is a structural cost advantage |
| Observability | **Prometheus (+Mimir) / Grafana / Loki / Tempo / OpenTelemetry** | No |
| Infrastructure | **Dedicated bare metal** (Hetzner/OVH) for workers; managed cloud for Postgres/KMS; cloud metal for burst | Added: this is the decision that determines whether the unit economics work |
| Signing / SBOM / scanning | **cosign / syft / trivy** | Added |
| Secrets | **KMS-backed envelope encryption**, vsock delivery | Added |

The only meaningful change to the proposed stack is **adding** things (the activator, the outbox, signing, the guest init, the egress proxies) and **deferring** things (NATS, WASM, multi-region, snapshots) rather than replacing anything. That is a good sign about the original list.

## 40.3 Balancing the five constraints

| Constraint | How this architecture serves it | What it costs |
|---|---|---|
| **Security** | Hardware virtualization as the primary boundary for both runtime and build; signed artifacts with admission control; defense in depth at every layer; an explicit threat model that names what is *not* solved | Density and cold start are worse than a container platform; the build system is more complex |
| **Performance** | Snapshots for ~50 ms cold starts; shared read-only rootfs with page-cache reuse; concurrency-based autoscaling; least-request LB; WASM for the sub-ms tier | Snapshot correctness is genuinely hard and security-relevant |
| **Scalability** | Stateless control plane; region-autonomous data plane; sampled placement that scales past 1000 workers; per-region schedulers; queue and storage choices that scale horizontally | Multi-region control-plane writes are cross-region; accepted because they are not on the request path |
| **Developer experience** | Zero-config for common runtimes; instant rollback by routing; previews with promotion-by-image; excellent, specific error messages; one config file with environment overrides; a CLI that is a plain API client | The error-message quality work is real engineering, not polish |
| **Cost** | Bare metal (10–20× cheaper than cloud metal); zero-egress object storage; aggressive caching; CPU overcommit; scale-to-zero; arm64 where possible | Bare metal cannot autoscale in minutes — capacity planning becomes a human process with headroom |
| **Operational complexity** | Six deployables, not fourteen; Postgres as the only hard source of truth; vendored registry and proxy; reconciliation over orchestration; agent restarts without draining | Envoy's xDS control plane and the Rust/Go split are the two places you are paying real complexity, both for good reasons |

## 40.4 The five decisions most likely to be regretted, and the counsel

1. **Building your own edge proxy too early.** Don't. Envoy until you can prove it is the bottleneck.
2. **Skipping the transactional outbox because "the queue is reliable."** You will spend a month debugging lost deployments. Build it in Phase 1; it is ~200 lines.
3. **Letting builds run in containers "just for now."** See C-1. Gate signups on it.
4. **Adding a second isolation tier for "trusted" customers.** Two security models means the weaker one defines your breach.
5. **Deferring the observability and error-message work as "not features."** They *are* the features. The difference between this platform and a worse one is almost entirely how good the failure experience is.

## 40.5 If you can only build three things well

1. **The isolation boundary** — Firecracker + jailer + netns + nftables, with the build plane inside it too. This is the product's license to exist.
2. **The deployment loop** — git push to live URL, fast, reliable, with excellent errors and instant rollback. This is what people pay for.
3. **The cold-start story** — image caching plus snapshots. This is what makes scale-to-zero usable rather than a footnote.

Everything else — multi-region, WASM, custom domains at scale, fine-grained RBAC, billing sophistication — can come later without rearchitecting, because the abstractions above (immutable OCI artifact, immutable ReleaseSpec, reconciling agent, generation-versioned routes) are designed to accommodate them.
