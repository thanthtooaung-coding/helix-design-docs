---
title: "34. Technology Decision Matrices"
description: "Runtime, queue, proxy and language comparisons with weighted scoring and final recommendations."
sidebar:
  order: 34
---

## 34.1 Runtime isolation

| Criterion (weight) | Containers (runc) | Containers (gVisor) | **Firecracker** | WASM (Wasmtime) |
|---|---|---|---|---|
| Isolation strength for untrusted code (×5) | 2 | 3.5 | **5** | 3.5 |
| Language/OS coverage (×4) | 5 | 4.5 | **5** | 2 |
| Cold start (×3) | 4 | 3.5 | 3 (**4.5** w/ snapshots) | **5** |
| Density (×3) | 4.5 | 4 | 3 | **5** |
| Operational maturity for this use (×2) | 5 | 3.5 | 4 | 3 |
| Ecosystem/tooling (×2) | 5 | 3.5 | 3.5 | 3 |
| **Weighted total** | 64.5 | 65.5 | **74.5** | 65 |

**Decision: Firecracker as the primary runtime, WASM as a second, opt-in runtime, containers as the packaging format only.** The weighting reflects that isolation is the product's core promise — if you weight isolation lower, containers win, which is exactly how platforms end up with breaches.

## 34.2 Messaging

| Criterion | **NATS (JetStream)** | Kafka | RabbitMQ |
|---|---|---|---|
| Operational burden | **Very low** — single Go binary, no ZK/KRaft ceremony | High — brokers, partitions, rebalancing, tuning | Medium — Erlang, quorum queues, mirroring |
| Latency | **Sub-ms** | ~2–10 ms | ~1–5 ms |
| Throughput | High (millions/s core NATS; ~100k–1M/s JetStream) | **Highest** sustained | Moderate (~50k/s) |
| Retention / replay | Days–weeks (JetStream, disk) | **Months, first-class** | Minimal (queues, not logs) |
| Work queue semantics | ✅ (pull consumers, ack, redelivery) | Awkward (consumer groups ≠ work queues; poor for long-running jobs) | **Excellent** |
| Request/reply | **Native, excellent** | No | Via RPC pattern |
| Pub/sub fan-out to 1000s of agents | **Excellent** (subject hierarchy, wildcards) | Poor (partition-per-consumer scaling) | Good |
| Built-in KV / object store | ✅ (useful for leader election, config) | No | No |
| Multi-region | **Gateways/leaf nodes, built for it** | MirrorMaker 2, painful | Federation, painful |
| Ecosystem / stream processing | Small | **Huge** (Connect, Streams, Flink, ClickHouse ingestion) | Medium |
| Rust + Go clients | **Excellent both** | Good Go, decent Rust | Good |

**Decision: NATS JetStream. <span class="mat mat-v1">V1</span>** — and **Postgres-as-a-queue for <span class="mat mat-mvp">MVP</span>**, adding NATS in Phase 3.

Why: your messaging needs are (a) a work queue for builds, (b) fan-out of control signals to thousands of agents, (c) a telemetry/usage firehose, (d) request/reply for a few internal calls. NATS does all four well with one lightweight binary and a multi-region story that is actually designed rather than bolted on. Kafka does (c) better and (a)/(b) worse, at several times the operational cost.

**When to introduce Kafka <span class="mat mat-scale">SCALE</span>:** when the usage/metrics event stream needs long retention and replay for analytics, when you need stream processing (Flink/Materialize) on request events, or when a single event stream exceeds ~500k msg/s sustained. Add it *alongside* NATS for that firehose; do not migrate control traffic.

**When RabbitMQ would be right:** complex routing topologies, per-message priority, and delayed delivery as first-class needs. You do not have those. Skip it.

**Critical caveat:** never make the queue the system of record. Postgres + transactional outbox is the source of truth ([§4.2](../04-deployment-pipeline/#42-step-by-step-with-failure-handling)); the queue is transport. This makes a queue migration a boring change rather than a rewrite.

## 34.3 Edge proxy

| Criterion | **Envoy** | HAProxy | Nginx OSS | Pingora (Rust, custom) |
|---|---|---|---|---|
| Dynamic config at high churn | **5** (xDS, delta) | 3 | 2 | 5 (you write it) |
| Dynamic certs at 50k+ domains | **5** (SDS) | 4 | 2 | 5 |
| HTTP/3 | 5 | 4 | 4 | 4 |
| Observability | **5** | 3.5 | 2.5 | 3 (you write it) |
| Extensibility (authz, wasm filters) | **5** | 3 | 2.5 | 5 |
| Raw performance / memory | 3 | **5** | 4.5 | **5** |
| Operational simplicity | 2 | 4 | **5** | 2 |
| Time to first working system | 3 | 4 | **5** | 1 |
| **Fit for this platform** | **Best** | Good | Poor | Best at scale, wrong now |

**Decision: Envoy + a Go xDS control plane + a separate Go activator. [MVP→V1]** Revisit a Rust data plane at <span class="mat mat-scale">SCALE</span> ([§11.2](../11-http-routing/#112-proxy-selection)).

## 34.4 Implementation language by component

| Criterion | Go | Rust | Java/Kotlin |
|---|---|---|---|
| Development velocity | **5** | 3 | 3.5 |
| Concurrency for network services | **5** (goroutines) | 4 (async/await, steeper) | 4 (virtual threads now good) |
| Low-level syscall / namespace work | 2 (thread-affinity problem, cgo) | **5** | 1 |
| Memory safety at a privileged boundary | 4 (safe, but GC) | **5** | 4 |
| Predictable latency (no GC) | 3.5 | **5** | 3 |
| Ecosystem for this domain | **5** (k8s, containerd, Envoy control planes, cloud SDKs) | 4 (rust-vmm, Firecracker, Wasmtime, tokio) | 3 |
| Binary size / footprint | 4 | **5** | 2 |
| Hiring pool | **5** | 3 | 5 |
| Compile times | **5** | 2 | 3 |

**Decisions:**

| Component | Language | Reason |
|---|---|---|
| `helix-control`, `helix-gateway`, `helix-builder`, `cli` | **Go** | Velocity, ecosystem (go-control-plane, containerd libs, cloud SDKs), easy concurrency, good-enough performance. The control plane is business logic, not systems programming |
| `helix-agent`, `vminit`, `wasm-host` | **Rust** | Namespaces are per-thread (Go's scheduler fights this); no GC pauses while managing thousands of VMs; memory safety at the most privileged boundary; shares the ecosystem with Firecracker and Wasmtime |
| Dashboard | **TypeScript** | — |
| Java/Kotlin for the control plane | **Rejected** | Heavier runtime, worse fit with the container/cloud-native ecosystem, no compelling advantage here. (Note: your Java/Spring experience transfers well to Go — the domain modeling is the hard part and it is language-independent) |

**Tradeoff acknowledged:** two languages means two toolchains, two CI paths, two dependency ecosystems, and a shared-schema problem (solved by generating both Go and Rust validation from one JSON Schema, [§29](../29-repository-structure/)). That cost is worth paying at exactly one boundary — the privileged/unprivileged line — and nowhere else. Resist adding a third.

## 34.5 Other decisions, summarized

| Decision | Choice | Runner-up | Why |
|---|---|---|---|
| Artifact format | **OCI image** | Buildpacks, custom bundles | Universal, mature ecosystem |
| Builder | **BuildKit** | Kaniko, Buildah, img | Best caching, LLB, secret/cache mounts, active development |
| Registry | **CNCF Distribution** (→ Zot for mirrors) | Harbor, cloud registries | Simple, S3-backed, stateless |
| Database | **PostgreSQL** | CockroachDB, MySQL | Maturity, RLS, `jsonb`, partitioning, `SKIP LOCKED`, extensions |
| Cache/coordination | **Redis** | etcd, Valkey | Ubiquitous; use Valkey if licensing matters to you |
| Leader election | **Postgres advisory locks** (→ NATS KV) | etcd, Consul | One fewer system to run at MVP |
| Object storage | **S3 API** (MinIO self-hosted / Cloudflare R2) | Ceph, SeaweedFS | Portability; R2's zero egress is a structural advantage |
| Metrics | **Prometheus + Mimir/Thanos** | VictoriaMetrics | Ecosystem; VictoriaMetrics is a legitimate cheaper alternative worth benchmarking |
| Logs | **Loki** | ClickHouse, Elasticsearch | Cost per GB; revisit if users demand full-text search |
| Traces | **Tempo** + OTel | Jaeger | Object-storage backed, Grafana-native |
| Secrets/KMS | **Cloud KMS** (or Vault + HSM) | Sealed secrets, SOPS | Hardware-backed key protection matters here |
| IaC | **OpenTofu/Terraform + Ansible** | Pulumi | Boring and well-understood |
| Migrations | **goose or Atlas**, forward-only | golang-migrate | Forward-only avoids the "down migration in production" trap |
