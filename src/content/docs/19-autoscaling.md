---
title: "19. Autoscaling"
description: "Three loops at three timescales: instances in seconds, workers in minutes, regions in weeks."
sidebar:
  order: 19
---

Three independent loops operating at different timescales. Confusing them is a common source of oscillation.

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph L1[&quot;Loop 1 — Application instances (seconds)&quot;]
        A1[Gateway concurrency metrics] --&gt; A2[Autoscaler: desired count] --&gt; A3[Placement] --&gt; A4[Agent starts/stops VMs]
    end
    subgraph L2[&quot;Loop 2 — Worker fleet (minutes)&quot;]
        B1[Aggregate pending placements + utilization] --&gt; B2[Capacity planner] --&gt; B3[Provision/decommission workers]
    end
    subgraph L3[&quot;Loop 3 — Regions (weeks)&quot;]
        C1[Traffic geography + latency SLO + demand] --&gt; C2[Human decision] --&gt; C3[New region buildout]
    end
    A4 -.-&gt;|utilization feedback| B1
    B3 -.-&gt;|capacity| A3</pre></figure>

## 19.1 Loop 1 — application instances

Algorithm in [§12.2](../12-serverless-scheduling/#122-autoscaling-algorithm). Key operational parameters:

| Parameter | Default | Rationale |
|---|---|---|
| Evaluation interval | 2 s | Fast enough to feel responsive |
| Stable window | 60 s | Damping |
| Panic window | 6 s | Spike response |
| Panic threshold | 2× | |
| Max scale-up per interval | `max(2, current)` — i.e. doubling | Prevents a metric glitch from creating 500 instances |
| Max scale-down per interval | `max(1, 10% of current)` | Gentle |
| Scale-down delay | 60 s | |
| Activation concurrency cap | 20 simultaneous cold starts per release | Protects workers and the registry |

**0 → 1** is special: driven by the activator on request arrival, not by the periodic loop.
**1 → N** is driven by concurrency.
**N → 0** requires zero requests for the full delay.

## 19.2 Loop 2 — worker fleet

**Signals:**
- `pending_placements` — instances the scheduler could not place. Any sustained non-zero value is an emergency.
- Fleet allocatable headroom per region/zone: `1 - (allocated_memory / allocatable_memory)`.
- Forecast: the same weekday/hour last week, plus recent trend.

**Policy:**

```text
target_headroom = 25%                  # enough to absorb a scale-up burst and one worker failure
if headroom < 15%  → provision workers (batch of ceil(deficit / worker_capacity), min 1)
if headroom > 45% sustained 30 min → cordon and drain the emptiest workers
never go below min_workers_per_zone = 2
never remove more than 1 worker per zone per 10 minutes
```

**Provisioning mechanics differ sharply by infrastructure:**

| Infrastructure | Provision time | Approach |
|---|---|---|
| Cloud metal (AWS `*.metal`, Equinix, OVH cloud) | 3–15 min | API-driven autoscaling; keep a small pool of pre-provisioned, cordoned "hot spare" workers to cover the provisioning gap |
| Dedicated bare metal (Hetzner AX/EX) | hours to days | **Cannot autoscale.** Capacity planning is a human process with weeks of lead time. Keep 30–40% headroom, and use a cloud-metal burst pool for spikes |
| Hybrid (recommended) | — | Baseline on cheap dedicated bare metal, burst on cloud metal. This is the cost-optimal shape ([§33](../33-cost-model/)) |

Because bare metal cannot scale in minutes, **the architecture must tolerate a saturated region**: admission control that queues new instance starts, cross-region spillover for releases that allow it, and honest 503s with `Retry-After` when neither is possible. Design this early; it is not an edge case at small scale, it is the normal Tuesday-afternoon case.

New workers must warm before serving: pull the top-N most common base images and runtime images, build their rootfs, and populate the warm pool, *then* mark Ready. A worker that goes Ready cold will receive traffic and give every one of those users a multi-second cold start.

## 19.3 Loop 3 — regions

Not automated. A region is: a rack or cloud footprint, a Postgres replica, a NATS cluster, an Envoy fleet, a registry mirror, an object storage endpoint, IP allocations, and compliance review. Plan it as a project ([§20.1](../20-high-availability/#201-target-topology)), not an autoscaling policy.
