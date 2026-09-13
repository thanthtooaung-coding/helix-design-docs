---
title: "18. Multi-Tenancy"
description: "The isolation boundaries, three layers of data isolation, quotas, and noisy-neighbor controls."
sidebar:
  order: 18
---

## 18.1 The boundaries

| Boundary | Enforced by |
|---|---|
| **Organization** | The billing, quota, and data boundary. Every row carries `org_id`; RLS enforces it |
| **Project** | Grouping + access control within an org; not a security boundary against the same org's other projects |
| **Environment** | Config and secret scope; production can be `protected` |
| **Instance** | The runtime isolation boundary (microVM) |
| **Worker** | The blast-radius boundary for a host compromise |
| **Region** | Data residency and failure domain |

## 18.2 Data isolation

Three layers, because one is not enough:
1. **Application layer** — every repository method takes an `org_id` and every query filters on it. Enforced by making the data-access layer require a `TenantContext` parameter; a query without one does not compile.
2. **Database layer** — PostgreSQL RLS policies on every tenant table, with `SET LOCAL app.current_org_id` at transaction start. A forgotten `WHERE` clause returns zero rows instead of everyone's data.
3. **Test layer** — an automated test that, for every table with `org_id`, verifies RLS is enabled and a cross-org read returns empty. Run in CI.

Object storage: per-org key prefixes and, for the registry, per-repository token scoping. Logs: tenant ID as a Loki label, and the log query API always injects the tenant filter server-side (never from client input).

## 18.3 Runtime isolation

Covered in [§6](../06-runtime-isolation-and-threat-model/). The multi-tenancy-specific rules:
- Different orgs' VMs never share a physical CPU core's sibling threads (core scheduling, [§6.6](../06-runtime-isolation-and-threat-model/#66-cpu-side-channels-and-smt-policy)).
- No guest-to-guest network path, even within an org, unless explicitly enabled.
- A per-org cap on instances per worker (blast radius).
- Snapshots are never shared across orgs, and snapshot files are encrypted with per-org keys.
- Build caches are per project.

## 18.4 Quotas and limits

Two categories with different enforcement:

| Type | Examples | Enforcement | Behavior on breach |
|---|---|---|---|
| **Hard limits** (protect the platform) | max instances, max memory per instance, max image size, max concurrent builds, API rate | Checked at admission, synchronously | Request rejected with a clear error |
| **Soft limits** (protect the bill) | monthly build minutes, egress GiB, request count | Metered asynchronously | Warn at 80%, notify at 100%, then either throttle or bill overage per plan. **Never** hard-stop a paying customer's production traffic without explicit consent — that is an outage you caused |

Free tier gets hard limits on everything including egress, because free tiers are where abuse lives ([§24](../24-abuse-prevention/)).

Quota checks must be cheap: cache the org's quota row in Redis with a short TTL, and count current usage from an authoritative source (`SELECT count(*) FROM instances WHERE org_id=$1 AND stopped_at IS NULL`) with a Redis counter as a fast path plus periodic reconciliation.

## 18.5 Noisy neighbor prevention

| Dimension | Control |
|---|---|
| CPU | `cpu.max` hard ceiling per instance; `cpu.weight` for fair share; core scheduling; monitor steal time per instance and alert when a worker's aggregate steal exceeds a threshold |
| Memory | No overcommit of configured maximums; `memory.high` for graceful pressure |
| Disk I/O | `io.max` per instance on the overlay device; separate NVMe for rootfs cache vs overlays; io.latency protection for the host's own needs |
| Network | `tc` HTB per VM; per-worker aggregate cap; conntrack limits |
| Page cache | Shared read-only rootfs is a *benefit*, but a tenant reading a huge file can evict others' pages. Accept; monitor; consider cgroup `memory.max` including page cache at <span class="mat mat-scale">SCALE</span> |
| Gateway | Per-tenant connection and queue budgets in the activator |
| Control plane | Per-org API rate limits; per-org concurrency limits on expensive operations (builds, log queries) |
| Database | Statement timeouts; separate connection pools for API vs background jobs so a slow report cannot starve the API |

**The worker-level cap is the most important one:** limit any single org to N% (e.g. 25%) of a worker's capacity. It costs a little packing efficiency and prevents one tenant from monopolizing a host.

## 18.6 Billing isolation

Every usage record carries `org_id`, `project_id`, `release_id`, `instance_id`, `region_id`. Metering happens at the agent and gateway ([§25](../25-billing-and-metering/)), independent of the control plane, so a control-plane outage does not lose billing data.
