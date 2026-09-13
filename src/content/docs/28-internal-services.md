---
title: "28. Internal Services"
description: "Six deployables, not fourteen, with the responsibility and failure behavior of each."
sidebar:
  order: 28
---

## 28.1 The inventory

| Service | Deployable? | Language | Datastore | API | Depends on | Scaling | Failure behavior |
|---|---|---|---|---|---|---|---|
| **API + Auth + Projects + Domains + Deployments + Usage** (`helix-control`) | Yes, one binary | Go | Postgres, Redis | REST (public), gRPC (internal) | Postgres, Redis, NATS, KMS, registry | Horizontal, stateless; 3+ replicas per region | Replicas fail independently; total loss = no control operations, data plane unaffected |
| **Scheduler + Autoscaler** | Module in `helix-control`, leader-elected | Go | Postgres, Redis | gRPC | Postgres, Redis, agents | Singleton per region + standbys | ≤5 s gap on leader loss |
| **Route Publisher / xDS** | Module in `helix-control` | Go | Postgres, Redis | xDS (gRPC) to Envoy | Postgres | Horizontal (each serves a consistent snapshot) | Envoy keeps last-known-good config |
| **`helix-gateway`** (activator + proxy) | **Yes, separate** | Go (Rust at SCALE) | Redis (cache) | HTTP in, HTTP out, gRPC to control | Redis, control plane (soft) | Horizontal, per region, CPU/connection-bound | Stateless; in-flight requests lost on a replica; serves stale routes during CP outage |
| **`helix-builder`** | **Yes, separate** | Go (+ Rust for the VM supervisor, shared with agent) | Postgres, NATS, object storage | gRPC/NATS | BuildKit, registry, object storage, egress proxy | Horizontal, bursty, on dedicated build workers | Builds orphaned and retried via lease expiry |
| **`helix-agent`** | **Yes, on every worker** | Rust | Local embedded DB | gRPC client; vsock server | Control plane (soft), registry | One per worker | Restart re-adopts running VMs ([§3.9](../03-compute-plane/#39-agent-restart-and-vm-adoption)) |
| **`helix-wasm-host`** | **Yes, per tenant per worker** | Rust | none | local socket from agent | agent | Process pool | Crash kills that tenant's wasm instances only |
| **Telemetry ingest (`helix-logd`)** | **Yes, separate** | Go | Loki, object storage | NATS consumer | NATS, Loki | Horizontal | Backpressure buffers at agents; loss is tolerable |
| **Usage aggregator** | Module in `helix-control` (extract at SCALE) | Go | Postgres | NATS consumer | NATS, Postgres | Horizontal with partitioned consumers | Idempotent; catches up after outage |
| **Registry** | **Yes, vendored** | — | Object storage (+ Postgres) | OCI Distribution API | Object storage | Horizontal, stateless | [§20.7](../20-high-availability/#207-registry-availability) |
| **Envoy** | **Yes, vendored** | — | — | HTTP/xDS | Route publisher | Horizontal per region | Last-known-good config |
| **Dashboard** | Yes | TypeScript/Next.js | — | Calls public API | API | Static/edge | Independent of the data plane |
| **Notification service** | Module in `helix-control` | Go | Postgres | NATS consumer | Email/Slack providers | Horizontal | Retries; non-critical |

**Count: 7 things you build and run + 2 vendored + 1 frontend.** Compare to the 14-microservice strawman.

## 28.2 Why each separation exists

| Split | Justification |
|---|---|
| gateway out of control | Different availability requirement (must survive CP outage) and different scaling axis (connections vs API calls) |
| builder out of control | Different trust level (orchestrates untrusted builds) and radically different resource profile |
| agent out of everything | Different trust level, runs on every host, must be tiny and in Rust |
| wasm-host out of agent | A Wasmtime escape must not land in the privileged agent; per-tenant process boundary |
| logd out of control | Write volume 100–1000× the API's; must not share a DB pool or a deploy cadence |

## 28.3 What stays in the monolith and why

Auth, projects, deployments, domains, secrets, scheduler, route publisher, usage aggregation, notifications. They share the same database, participate in the same transactions (creating a project creates environments, a default domain, and quota rows — one transaction), and have the same availability and scaling profile. Splitting them buys distributed transactions and a saga framework you do not need.

**Module boundary discipline** (the thing that makes this work):
```text
internal/
  auth/        api/  service.go  store.go        ← owns tables: users, memberships, api_tokens
  project/     api/  service.go  store.go        ← owns: projects, environments
  deploy/      api/  service.go  store.go        ← owns: deployments, builds, releases
  domain/      api/  service.go  store.go        ← owns: domains, certificates
  secret/      api/  service.go  store.go        ← owns: secrets, env_vars, data_keys
  schedule/    api/  service.go  store.go        ← owns: workers, instances, reservations
  usage/       api/  service.go  store.go        ← owns: usage_records, quotas
  platform/    db/ nats/ kms/ authz/ telemetry/  ← shared infrastructure
```
Rule: `deploy` may import `project.Service` (an interface), never `project.Store` and never `SELECT ... FROM projects`. Enforce with an import linter in CI (`go-arch-lint` or `depguard`). This one rule is what keeps a modular monolith from becoming a big ball of mud, and it makes extraction later a mechanical change.
