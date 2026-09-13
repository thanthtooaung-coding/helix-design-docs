---
title: "12. Serverless Scheduling"
description: "Concurrency-based autoscaling, the placement algorithm, the cold-start decision tree and scale-to-zero."
sidebar:
  order: 12
---

## 12.1 What the scheduler decides

Four distinct decisions that are often conflated:

| Decision | Frequency | Latency budget | Where |
|---|---|---|---|
| **How many instances should release R have?** (autoscaling) | Every 2 s per active release | Seconds | Autoscaler (per region) |
| **Which worker should instance I go on?** (placement) | Per instance creation | < 50 ms | Placement engine (per region) |
| **Which instance should this request go to?** (load balancing) | Per request | < 1 ms | Gateway, local |
| **Which region should this request/deployment go to?** | Per request (DNS/anycast) / per deployment | — | GeoDNS + anycast; deployment config |

Separating these is essential. Per-request decisions must never touch the control plane.

## 12.2 Autoscaling algorithm

**Primary signal: concurrency**, not CPU.

Reasoning: for request-driven workloads, in-flight request count is a direct measure of demand, is available instantly at the gateway, and does not lag the way CPU does. CPU is a poor proxy for an I/O-bound app (a Node app waiting on a database is at 3% CPU while being completely saturated on concurrency). Knative learned this; AWS Lambda's model is pure concurrency.

```text
desired = ceil( observed_concurrency / target_concurrency )
desired = clamp(desired, min_instances, max_instances)
```

Observed concurrency is the average in-flight requests for the release over a sliding window, aggregated from all gateway replicas (each gateway publishes its counts to Redis/NATS every 1 s; the autoscaler sums).

**Two windows, Knative-style:**
- *Stable window* (60 s): smooth scaling, avoids flapping.
- *Panic window* (6 s): if `desired_panic > 2 × current`, enter panic mode and scale to the panic figure immediately. Exit panic after the stable window is calm. This is what handles a traffic spike without a 60 s lag.

**Secondary signals (optional, per-project):** `target_cpu_percent` and `target_rps`. Take the **maximum** of all enabled signals' desired counts — scaling up on any saturated dimension is correct; scaling down requires *all* to be below target.

**Scale-down** is deliberately asymmetric: up fast, down slow. `scale_down_delay` (default 60 s) must elapse with `desired < current` before removing an instance, and remove at most `max(1, 10% of current)` per interval. Scaling to zero waits `scale_down_delay` plus an idle check (no requests at all).

**Special cases:**
- WebSocket/streaming connections pin instances: exclude long-lived connections from the concurrency average (or they permanently inflate it) but do prevent scale-down of an instance holding them.
- Instances with in-flight requests are never killed; drain first.
- `min_instances > 0` disables scale-to-zero and the activator path entirely for that release.

## 12.3 Placement algorithm

**Problem.** Pick a worker for a new instance, in < 50 ms, across a fleet of hundreds, optimizing for cold-start latency, packing efficiency, and isolation — without a global lock.

**Candidates:**

| Approach | Assessment |
|---|---|
| Full scan + score all workers | O(N) per placement; fine to ~1000 workers if state is in memory; simple and gives the best decisions |
| **Filter + score a sampled subset (power-of-two-choices style)** | O(k); scales indefinitely; near-optimal in practice |
| Consistent hashing on release id | Excellent for image-cache locality, poor for balance, bad when a release is hot |
| Bin packing (first-fit-decreasing) | Good density, ignores cold-start locality |

**Decision: filter → score → pick best of a sample of k=8 (plus always include up to 3 workers that already have the image/snapshot cached).** Hybrid of P2C and cache-affinity.

```text
FILTER (hard constraints — a worker is eligible only if all hold)
  ✓ status == Ready and not cordoned
  ✓ region and zone match the release's placement constraints
  ✓ architecture matches
  ✓ free_memory ≥ instance memory + host reserve
  ✓ free_cpu_shares ≥ instance cpu (under the node's overcommit ratio)
  ✓ instance_count < node max
  ✓ tenant anti-affinity: (optional) this org has < max_per_node instances here
  ✓ spread: this release has < ceil(desired / min_zones) instances in this zone

SCORE (weighted sum, higher is better)
  + 40  has warm snapshot for this release locally
  + 25  has rootfs for this image digest locally
  + 15  has the base image layers locally (partial cache)
  + 20 * (1 - memory_utilization)        # prefer emptier nodes ... but
  - 10 * bin_packing_penalty            # ... prefer packing when utilization < 50%
  + 10  zone matches the requesting gateway's zone
  -  5 * recent_failure_count(worker)   # penalize flaky nodes
  - 30  node is in a different zone than existing instances of this release (spread bonus inverted)
  + 15  worker already runs instances of this ORG (cache + core-scheduling affinity)
  - 50  worker already runs > N instances of this org (blast-radius / noisy-neighbor cap)
```

The two org-related terms are deliberately opposed: mild affinity for cache and core-scheduling efficiency, hard penalty past a cap so a single tenant cannot colonize a node.

**Concurrency safety.** Placement must not oversubscribe a node when several schedulers/goroutines place simultaneously. Use optimistic reservation: the placement engine writes a reservation row (`worker_id, instance_id, memory, expires_at`) with a conditional update against the worker's capacity, in one transaction. If the agent does not confirm within the TTL, the reservation expires and capacity is returned. The **agent is the final authority** — it rejects an assignment it cannot satisfy, and the scheduler re-places.

**Leader election.** One autoscaler+placement leader per region, elected via a Postgres advisory lock with a lease (or NATS KV). Followers are hot standbys. Loss of leader → up to `lease_ttl` (5 s) of no new placements. Running instances are unaffected because the data plane is independent.

## 12.4 Instance selection for cold start: the decision tree

<figure class="mermaid-figure"><pre class="mermaid">graph TD
    A[Need instance for release R] --&gt; B{min_instances met?}
    B --&gt;|yes, warm instance has capacity| C[Route to existing instance — no action]
    B --&gt;|no| D{Warm-pool VM available&lt;br/&gt;matching runtime+resources?}
    D --&gt;|yes| E[&quot;Claim pooled VM&lt;br/&gt;inject env, exec app ≈ 20–100 ms&quot;]
    D --&gt;|no| F{Snapshot for R on any eligible worker?}
    F --&gt;|yes| G[&quot;Restore snapshot with UFFD ≈ 10–60 ms&quot;]
    F --&gt;|no| H{Rootfs for R&#x27;s digest cached on an eligible worker?}
    H --&gt;|yes| I[&quot;Cold boot from cached rootfs ≈ 120 ms + app start&quot;]
    H --&gt;|no| J{Image layers in any peer worker&#x27;s cache?}
    J --&gt;|yes| K[&quot;Peer-to-peer layer fetch → build rootfs → boot&quot;]
    J --&gt;|no| L[&quot;Pull from registry → build rootfs → boot&lt;br/&gt;(worst case: seconds)&quot;]
    E &amp; G &amp; I &amp; K &amp; L --&gt; M[Startup probe]
    M --&gt;|pass| N[Ready, register endpoint]
    M --&gt;|fail before deadline| O[Kill, retry elsewhere, count failure]</pre></figure>

## 12.5 Scale-to-zero decision

A release scales to zero when **all** hold:
- `min_instances == 0`
- No request in the last `scale_down_delay` (default 60 s)
- No in-flight requests, no open WebSockets
- No active background work signal (if the app opts into a "keepalive" API)

On scale-to-zero: gracefully stop instances, take a snapshot from the *last* instance if snapshot policy allows, mark the route as "cold" so the gateway knows to activate, and retain the snapshot + rootfs on that worker with a bias so the next activation lands there.

**Anti-flap:** if a release scales 0↔1 more than N times in an hour, automatically pin `min_instances = 1` for an hour and surface a recommendation. Constant cold starts are worse for the user and more expensive for you than one idle instance.

## 12.6 Geographic placement

| Decision | Mechanism |
|---|---|
| Which region serves a request | Anycast BGP (best) or GeoDNS (simpler). Anycast gives automatic failover and no DNS TTL problems; GeoDNS is far easier to start with |
| Which regions run a release | Explicit in config (`environments.production.regions`). Do not auto-expand — it surprises users with cost |
| Cross-region fallback | If a release has no healthy instance in the local region, the gateway may proxy to the nearest region that does, with a latency penalty, flagged in response headers and metrics. Configurable per project (some users would rather 503 than serve from another continent for data-residency reasons) |
| Data residency | A hard constraint flag per project that forbids cross-region fallback and cross-region log shipping |
