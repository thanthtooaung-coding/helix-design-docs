---
title: "25. Billing and Metering"
description: "What to meter, how to collect it without touching the request path, and the edge cases that cause disputes."
sidebar:
  order: 25
---

## 25.1 What to meter

| Metric | Unit | Source | Granularity |
|---|---|---|---|
| CPU time | vCPU-seconds | Agent, from cgroup `cpu.stat` | 60 s window per instance |
| Memory time | GiB-seconds (configured, not used — users buy an allocation) | Agent, from instance config × duration | 60 s |
| Instance time | instance-seconds | Agent | 60 s |
| Requests | count | Gateway | 60 s |
| Egress bandwidth | bytes | Gateway (response bytes) + agent (instance egress) | 60 s |
| Build time | build-seconds × build size class | Builder | Per build |
| Artifact storage | GiB-hours | Registry/object-store accounting job | Hourly |
| Log storage | GiB-hours | Loki accounting | Hourly |
| Active deployments / projects / domains | count | Control plane | Daily snapshot |

**Pricing model recommendation:** charge for instance-time (vCPU-s + GiB-s) with a per-request component and metered egress — the Lambda/Cloud Run shape. It is the model customers understand, it maps directly to your costs, and scale-to-zero becomes a genuine benefit to them rather than an accounting puzzle. Avoid billing for "CPU actually used" alone; it makes your revenue unpredictable while your costs are allocation-driven.

## 25.2 Collection without impacting the runtime

Hard requirements: metering must not add latency to requests, must not block the guest, and must survive component failure.

<figure class="mermaid-figure"><pre class="mermaid">graph LR
    subgraph W[&quot;Worker&quot;]
        CG[&quot;cgroup counters (already maintained by the kernel)&quot;]
        AG2[&quot;Agent sampler: read counters every 60s (O(instances), microseconds)&quot;]
        BUF[&quot;Local durable buffer (bounded, disk-backed)&quot;]
    end
    subgraph GWM[&quot;Gateway&quot;]
        CTR[&quot;In-memory counters per release, incremented on response completion&quot;]
        BUF2[&quot;Local buffer&quot;]
    end
    CG --&gt; AG2 --&gt; BUF --&gt; NQ[(NATS JetStream: usage.raw)]
    CTR --&gt; BUF2 --&gt; NQ
    NQ --&gt; AGGR[&quot;Usage aggregator (idempotent, dedup_key)&quot;]
    AGGR --&gt; PGU[(&quot;usage_records (partitioned)&quot;)]
    PGU --&gt; ROLL[&quot;Hourly/daily rollups&quot;]
    ROLL --&gt; BILL[&quot;Billing provider (Stripe) — metered subscription items&quot;]
    ROLL --&gt; DASH[Customer usage dashboard]</pre></figure>

Design points:
- **Sampling, not instrumentation.** CPU and memory come from counters the kernel already maintains. Reading them costs microseconds. There is zero instrumentation in the request path or the guest.
- **Request counting happens where the response completes** (gateway), incrementing an in-memory counter. No per-request database write, ever.
- **Local durable buffering** on the agent and gateway means a NATS outage delays billing data, it does not lose it. Buffer is bounded (e.g. 1 h of data); on overflow, emit a metric and drop the *oldest* with a gap marker rather than blocking.
- **`dedup_key` = hash(source, instance_id, window_start, metric)** makes replay idempotent — exactly the property you need under at-least-once delivery.
- **Aggregation is a separate service** so a slow rollup never touches the request path.
- **Reconciliation job** compares instance-seconds derived from the `instances` table (assigned_at → stopped_at) against reported usage. Discrepancies over a threshold are an alert — this catches both lost data and a metering bug, and you want to find those before a customer does.

## 25.3 Partial-minute and edge cases

| Case | Handling |
|---|---|
| Instance runs 3 s | Bill a minimum billable duration (e.g. 100 ms granularity, or a 1-second minimum). Decide and document |
| Instance killed by the platform (worker failure) | Do not bill for the failed window, and do not bill the replacement's cold start. Small cost to you; large trust benefit |
| Cold start time | Billable or not? **Recommend: not billed** for the platform's portion (VM boot), billed for the app's startup. Simpler alternative: bill from "instance ready." Pick one and be explicit — this is a common source of billing complaints |
| Clock skew across workers | Use the *aggregator's* receipt window bucketing with the worker's timestamp as a hint; require NTP on all workers and alert on skew > 1 s |
| Double-reported window after agent restart | `dedup_key` handles it |
| Free tier | Apply credits at rollup time, not at metering time — meter everything, discount later |

## 25.4 Billing integration

Stripe (or equivalent) with metered subscription items. Push usage once daily (and at period close) rather than continuously — fewer API calls, easier reconciliation. Keep your own `usage_records` as the source of truth; the billing provider is a downstream consumer, never the record.

Handle: plan changes mid-period (proration), failed payments (dunning → grace period → suspend non-production first, then production, with plenty of warning), spending limits (a hard cap customers can set — this is a *feature*, because the fear of a runaway bill is the #1 objection to usage-based pricing), and usage alerts at 50/80/100%.
