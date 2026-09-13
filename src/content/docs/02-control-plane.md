---
title: "2. Control Plane"
description: "Modular monolith over microservices, component responsibilities, and an explicit stateless/stateful inventory."
sidebar:
  order: 2
---

## 2.1 Architecture decision: monolith or services?

**Problem.** The requirement list names 14 candidate services. Naively implementing them as 14 deployables on day one buys distributed-systems pain in exchange for organizational benefits you do not yet have (you do not have 14 teams).

**Candidates.**

| Option | Pros | Cons |
|---|---|---|
| A. 14 microservices | Independent scaling and deploys; clear ownership | 14× the ops; distributed transactions across project/deployment/domain; enormous latency budget spent on internal hops; unusable for a small team |
| B. **Modular monolith + a small number of genuinely separate processes** | One DB transaction covers most business operations; fast local dev; refactorable module boundaries; still splits things that have different *resource and trust* profiles | Requires discipline to keep module boundaries clean; one deploy unit for control-plane changes |
| C. Single process for everything including workers and router | Simplest | Violates trust boundaries and resource isolation. Non-starter. |

**Decision: Option B. [MVP → V1]**

The split rule is not "one service per noun." It is: **split only when two components differ in trust level, resource profile, scaling axis, or availability requirement.**

By that rule, the separate deployables are:

| Deployable | Language | Why separate |
|---|---|---|
| `helix-control` (modular monolith: API, auth, projects, deployments, domains, env/secrets, orchestrator, scheduler, route publisher, git, usage) | Go | — |
| `helix-gateway` (activator + route cache; Envoy sits in front) | Go (Rust at SCALE) | Different availability requirement (must survive CP outage), different scaling axis (requests/sec not API calls), different latency budget |
| `helix-builder` | Go | Different trust level (drives untrusted builds), different resource profile (CPU/disk heavy, bursty) |
| `helix-agent` | Rust | Runs on every worker, different trust level, no network path to the DB |
| `helix-logd` / telemetry ingestion | Go | Very different write volume; must not be able to stall the API's DB pool |
| `helix-registry` (Distribution/Zot) | vendored | Off-the-shelf |

Six deployables, not fourteen. Inside `helix-control`, the modules are compile-time packages with explicit interfaces and **no cross-module DB access** — module A calls module B's Go interface, it does not `SELECT` from B's tables. That single rule is what makes a future extraction to a separate service a mechanical refactor rather than a rewrite.

When to split further <span class="mat mat-scale">SCALE</span>: extract the Scheduler when placement decisions exceed ~1k/s or when you need a scheduler per region with independent leader election; extract Usage/Metering when ingest volume forces a separate datastore; extract Auth when you sell SSO/SCIM to enterprises.

## 2.2 Control plane component responsibilities

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph EDGE2[&quot;Edge&quot;]
        LB[L4 LB / Anycast] --&gt; APIGW[Envoy: API listener&lt;br/&gt;TLS, rate limit, WAF, body limits]
    end
    subgraph MONO[&quot;helix-control (single Go binary, N replicas)&quot;]
        direction TB
        HTTPAPI[HTTP/REST handlers + gRPC internal]
        AUTHZ[AuthN / AuthZ&lt;br/&gt;sessions, PATs, OIDC, RBAC]
        IDENT[Identity: users, orgs, teams, members, invites]
        PROJ[Projects, environments, config]
        SEC[Env vars &amp;amp; secrets&lt;br/&gt;envelope encryption]
        DEPLOY[Deployment orchestrator&lt;br/&gt;state machine]
        SCHEDM[Scheduler&lt;br/&gt;leader-elected]
        ROUTEP[Route publisher&lt;br/&gt;xDS + Redis route cache]
        DOM[Domains &amp;amp; certificates&lt;br/&gt;ACME]
        GITM[Git integrations&lt;br/&gt;OAuth, webhooks, checks]
        QUOTA[Quotas &amp;amp; rate limits]
        USG[Usage aggregation &amp;amp; billing hooks]
        AUD[Audit log writer]
    end
    APIGW --&gt; HTTPAPI --&gt; AUTHZ
    AUTHZ --&gt; IDENT &amp; PROJ &amp; SEC &amp; DEPLOY &amp; DOM &amp; GITM
    DEPLOY --&gt; SCHEDM --&gt; ROUTEP
    DEPLOY &amp; SCHEDM &amp; DOM --&gt; OUTBOX[(Transactional Outbox)]
    OUTBOX --&gt; NATS2[(NATS JetStream)]
    MONO --&gt; PG2[(PostgreSQL primary)]
    MONO --&gt; RD2[(Redis)]</pre></figure>

| Component | Responsibility | Notes |
|---|---|---|
| **API Gateway** (Envoy) | TLS termination for the API, global rate limiting, request body size caps, IP reputation, routing `/v1/*` to control replicas | Deliberately *not* doing authentication — authz needs business context |
| **AuthN** | Session cookies (dashboard), PATs (CLI/CI), OIDC/SAML <span class="mat mat-scale">SCALE</span>, GitHub App installation tokens, worker mTLS/SPIFFE | [§23.1](../23-security-architecture/#231-authentication) |
| **AuthZ** | RBAC: `org → role → permission`, scoped to `project`/`environment`. Deny-by-default. Evaluated in one place, never in handlers ad hoc | [§16.8](../16-api-design/) |
| **Identity** | Users, organizations, teams, memberships, invitations | |
| **Projects** | Project CRUD, environments (production/preview/custom), linked repo, build/run config defaults | |
| **Secrets** | Envelope encryption: per-org DEK wrapped by KMS CMK; ciphertext in Postgres; plaintext never logged; decryption only at deploy-materialization time | [§23.4](../23-security-architecture/#234-secrets-management) |
| **Deployment orchestrator** | Owns the deployment state machine ([§38.8](../38-distributed-systems-concerns/#388-deployment-state-machine)). Drives build → schedule → health → promote. Idempotent, resumable, crash-safe | The heart of the system |
| **Scheduler** | Placement decisions, desired-instance-count per release, scale-to-zero decisions, worker selection | Leader-elected per region ([§12](../12-serverless-scheduling/)) |
| **Route publisher** | Translates "release R is ready on workers X,Y with instance endpoints" into Envoy xDS snapshots and a Redis route table | [§11.3](../11-http-routing/#113-route-table-and-propagation) |
| **Domains** | Custom domain verification, ACME DNS-01/HTTP-01, cert storage and renewal, wildcard certs | [§11.5](../11-http-routing/#115-tls-domains-and-certificates) |
| **Git** | OAuth app + GitHub App/GitLab/Bitbucket, webhook ingestion + signature verification, commit status, PR comments | [§17](../17-git-integration-and-preview-deployments/) |
| **Quotas** | Hard limits (max concurrent builds, max instances, max image size) checked at admission; soft limits reported | [§18.4](../18-multi-tenancy/#184-quotas-and-limits) |
| **Usage** | Aggregates metering events into billable rollups, emits to billing provider | [§25](../25-billing-and-metering/) |
| **Audit** | Append-only record of every mutating action with actor, IP, before/after | [§23.7](../23-security-architecture/#237-audit-logging) |

## 2.3 Stateless vs stateful — the explicit inventory

This was asked for directly, and the distinction matters for how you deploy and recover each piece.

| Component | Classification | Where its state actually lives | Failure behavior |
|---|---|---|---|
| Envoy (API listener) | **Stateless** | xDS snapshot in memory, sourced from control plane | Restart freely; falls back to last-known config on CP outage |
| `helix-control` API handlers | **Stateless** | Postgres, Redis | Kill any replica; N+2 replicas behind LB |
| AuthN session verification | **Stateless** (sessions in Redis) | Redis + Postgres | Redis loss = forced re-login, not data loss |
| Deployment orchestrator | **Stateful logic, stateless process** | Postgres (`deployments` table = the state machine) | Any replica can resume any deployment by reading the row. Crash mid-transition is safe because transitions are single transactions with guards |
| Scheduler | **Singleton-per-region, stateless process** | Postgres (desired state) + Redis (worker liveness) | Leader election via Postgres advisory lock or NATS KV. Loss of leader = no new placements for a few seconds; running instances unaffected |
| Route publisher | **Stateless** | Derives from Postgres + agent reports | Restart re-derives full snapshot |
| `helix-gateway` / activator | **Soft state** | In-memory route cache + in-flight request queue; backed by Redis | Restart drops in-flight requests on that replica (clients retry); cache repopulates from Redis in <1s |
| `helix-builder` coordinator | **Stateless** | Postgres (`builds`) + NATS work queue | Build in progress is orphaned and retried ([§5.11](../05-build-system/#511-attack-tree-malicious-build)) |
| `helix-agent` | **Stateful — authoritative for its own node** | Local BoltDB/sqlite + the actual running VMs | This is the one place where local state is the truth. Agent restart must re-adopt running VMs, not kill them ([§3.9](../03-compute-plane/#39-agent-restart-and-vm-adoption)) |
| PostgreSQL | **Stateful** | Disk | Primary + sync standby + async replica ([§20.2](../20-high-availability/#202-postgresql)) |
| Redis | **Stateful, but reconstructible** | Memory + AOF | Designed so that total Redis loss degrades but does not corrupt |
| NATS JetStream | **Stateful** | Disk, R3 | Message loss = delayed/retried work, never lost billing data (dual-write to Postgres outbox) |
| OCI Registry | **Stateful** | S3 + Postgres metadata | [§20.7](../20-high-availability/#207-registry-availability) |
| Object storage | **Stateful** | The durability floor of the whole system | |

**Rule of thumb applied throughout:** the only components allowed to hold non-reconstructible state are Postgres, object storage, and (transiently) the worker agent. Everything else must be able to rebuild its state from those three.

## 2.4 Redis: what it is and is not allowed to do

Redis is easy to misuse into becoming a second source of truth. Explicit allowed uses:

| Allowed | Why |
|---|---|
| Session store | Loss = re-login |
| Rate limit counters (sliding window) | Loss = brief over-permissiveness |
| Worker heartbeat / liveness (`SETEX worker:{id} 15s`) | Loss = workers re-register within one heartbeat |
| Hot route table cache for the gateway | Loss = gateway falls back to gRPC fetch from control plane |
| Warm-instance index (`release:{id}:instances` sorted set) | Loss = treated as cold, scheduler re-populates |
| Short-lived distributed locks (with fencing tokens, [§38.3](../38-distributed-systems-concerns/#383-distributed-locks-leases-and-fencing)) | Never the *only* guard — Postgres constraints are the real guard |
| Activation coalescing (single-flight per release) | Loss = duplicate cold starts, wasteful not incorrect |

**Forbidden:** billing/metering data, deployment state, secrets, anything where loss requires human intervention.

**Deployment <span class="mat mat-v1">V1</span>:** Redis Sentinel or a managed Redis with automatic failover. Redis Cluster only at <span class="mat mat-scale">SCALE</span>, and only after you have measured that a single primary is actually the bottleneck.

## 2.5 Idempotency and API-level correctness

Every mutating endpoint accepts `Idempotency-Key`. Implementation:

```sql
CREATE TABLE idempotency_keys (
  key            text        NOT NULL,
  org_id         uuid        NOT NULL,
  endpoint       text        NOT NULL,
  request_hash   bytea       NOT NULL,
  response_code  int,
  response_body  jsonb,
  state          text        NOT NULL,  -- in_progress | complete
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key, endpoint)
);
```

Flow: `INSERT ... ON CONFLICT DO NOTHING`. If inserted, you own the operation. If not inserted and `state = complete` and `request_hash` matches, replay the stored response. If hash differs → `409 Conflict`. If `in_progress` → `409` with `Retry-After`. Rows expire after 24h.

This is boring and it is the difference between "customer's CI double-fired the webhook and created two deployments" and a correct system.
