---
title: "20. High Availability"
description: "The multi-region topology, the failure matrix, the autonomy principle and split-brain prevention."
sidebar:
  order: 20
---

## 20.1 Target topology

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph GLOBAL[&quot;Global&quot;]
        DNS2[&quot;DNS / Anycast&quot;]
        S3G[(&quot;Object storage — cross-region replicated&quot;)]
        KMS2[KMS / HSM]
    end
    subgraph RA[&quot;Region A — primary&quot;]
        direction TB
        EA[Envoy fleet ×N]
        GA[helix-gateway ×N]
        CA[&quot;helix-control ×N (all roles)&quot;]
        SCHA[Scheduler leader A]
        PGA[(&quot;PostgreSQL primary + sync standby&quot;)]
        RDA[(Redis HA)]
        NA[(NATS JetStream R3)]
        REGA[(Registry)]
        WA1[Workers ×M]
    end
    subgraph RB[&quot;Region B&quot;]
        direction TB
        EB[Envoy fleet ×N]
        GB[helix-gateway ×N]
        CB[&quot;helix-control ×N (read + local scheduling)&quot;]
        SCHB[Scheduler leader B]
        PGB[(&quot;PostgreSQL async replica&quot;)]
        RDB[(Redis HA)]
        NB[(NATS JetStream R3)]
        REGB[(Registry mirror)]
        WB1[Workers ×M]
    end
    DNS2 --&gt; EA &amp; EB
    EA --&gt; GA --&gt; WA1
    EB --&gt; GB --&gt; WB1
    CA --&gt; PGA
    CB --&gt;|writes| PGA
    CB --&gt;|reads| PGB
    PGA -.-&gt;|streaming replication| PGB
    REGA -.-&gt;|sync| REGB
    NA &lt;-.-&gt;|gateway/leafnode| NB
    RA &amp; RB --&gt; S3G</pre></figure>

## 20.2 PostgreSQL

**Decision: single logical primary, synchronous standby in the same region, asynchronous replica in the secondary region. <span class="mat mat-v1">V1</span>**

| Option | Assessment |
|---|---|
| Single instance + backups | MVP only |
| **Primary + sync standby (same region) + async replica (other region)** | RPO 0 within region, RPO seconds cross-region, RTO ~30 s with automatic failover. Standard, well-understood. **Chosen** |
| Multi-primary (BDR, Citus multi-master) | Conflict resolution complexity not justified |
| Distributed SQL (CockroachDB, Yugabyte) | Genuinely solves multi-region writes, but: higher latency per transaction, different operational model, weaker Postgres compatibility in corners, and more expensive. Revisit at <span class="mat mat-scale">SCALE</span> if cross-region write latency becomes a product problem |

Tooling: **Patroni** + etcd/Consul for leader election and automatic failover, or a managed Postgres if you are on a cloud that has a good one. Connection routing via PgBouncer (transaction pooling) + HAProxy/pgpool in front, or Patroni's REST-driven endpoints.

**Cross-region write latency is the key constraint.** Region B's control plane writes to Region A's primary, adding ~50–200 ms per write. This is acceptable because writes are control-plane operations (deploy, config), not request-path. The request path in Region B touches **no database at all**.

Additional practices: `synchronous_commit = on` with `synchronous_standby_names` set to the local standby; statement timeouts; separate pools per workload; `pg_stat_statements`; partition the big append-only tables; and test failover monthly, in production, on purpose.

## 20.3 Failure matrix

| Failure | Detection | Impact | Recovery | Requests lost? |
|---|---|---|---|---|
| **Single `helix-control` replica** | LB health check | None | LB removes it; N-1 replicas serve | No |
| **All control replicas in a region** | Alert | No deploys, no scale-up, no cold starts for scale-to-zero apps in that region. **Warm traffic unaffected** | Restart/failover; other region's control plane can drive workers if configured for cross-region control | Cold-start requests only |
| **Postgres primary** | Patroni | Writes fail ~15–45 s (deploys 503, reads served by replicas if the app supports it) | Automatic promotion of sync standby; connection strings via service discovery so apps reconnect | Deploy API calls in flight |
| **Postgres both primary and standby** | Alert | Control plane read-only at best | Promote the cross-region async replica — **accept RPO of seconds and reconcile** ([§21](../21-disaster-recovery/)) | Recent writes |
| **Redis** | Sentinel | Sessions lost (re-login), rate limits reset, gateway falls back to gRPC route fetch, single-flight degrades | Sentinel failover; caches refill | No |
| **NATS node** | Cluster | None (R3) | Automatic | No |
| **NATS cluster** | Alert | Telemetry buffered at agents (bounded); build queue falls back to Postgres polling if implemented | Restart; agents drain buffers | Telemetry beyond buffer |
| **Scheduler leader** | Lease expiry | No new placements for ≤5 s | Follower acquires lease | No |
| **A worker** | 3 missed heartbeats (15 s) | Its instances' in-flight requests fail; gateway ejects endpoints within ~2 s via connection errors | Scheduler replaces instances elsewhere; worker fenced | In-flight on that worker |
| **Many workers (rack/PDU)** | Zone-level | Capacity loss; releases with instances only there go cold | Zone-aware spread means most releases keep instances elsewhere; scheduler backfills | Some |
| **Envoy replica** | L4 health | Connections on it drop | L4 LB reroutes; clients reconnect | In-flight on that replica |
| **Entire edge in a region** | Anycast/GeoDNS health | Traffic shifts to another region | Automatic with anycast (BGP withdrawal), 60–300 s with GeoDNS TTL | Some during shift |
| **Registry** | Pull failures | New instance starts fail where the image is not cached; **warm instances unaffected** | Regional mirrors + worker caches + object-storage-backed HA registry | Cold starts of uncached images |
| **Object storage** | API errors | Registry degraded (unless cached), no new builds (artifact push), no log archive, snapshots unavailable | Multi-AZ object store; cross-region replication; workers serve from local cache | Builds |
| **DNS provider** | External monitoring | Catastrophic if total | **Use two DNS providers** with the same zone (e.g. Route53 + NS1/Cloudflare) and NS records for both. This is cheap insurance against a provider outage, which has happened to everyone | New resolutions |
| **Network partition between regions** | Cross-region probes | Region B cannot write to Postgres → no deploys in B; B's data plane keeps serving | Region B enters "degraded autonomous" mode: serves traffic, no control changes. **Must not** promote its own primary automatically (split brain) | No |
| **KMS unavailable** | API errors | Cannot decrypt secrets → new instance starts fail for apps with secrets | Cache unwrapped DEKs in control-plane memory with a TTL (a deliberate, documented tradeoff); multi-region KMS | Cold starts |

## 20.4 The autonomy principle

Each region must be able to serve existing traffic with **zero** cross-region dependencies:
- Envoy has its config.
- Gateway has its route table.
- Workers have their images and are running their instances.
- Metering buffers locally and ships later.

Cross-region dependencies are acceptable only for: creating deployments, changing config, and cross-region scheduling. All of those can be unavailable for minutes without a customer-visible outage.

## 20.5 Split brain prevention

- **Postgres:** only Patroni/etcd may promote. Never automatic cross-region promotion; it requires a human with a runbook, because the network partition case and the "region is actually gone" case look identical from inside.
- **Scheduler:** leases with fencing tokens ([§38.3](../38-distributed-systems-concerns/#383-distributed-locks-leases-and-fencing)). Worker `generation` increments on re-registration; the control plane rejects reports carrying a stale generation.
- **Workers:** a worker that cannot reach any control plane for `self_fence_timeout` (default 5 min) stops its instances. Better a clean stop than two regions both believing they own a release and both serving stale code.
- **Route table:** monotonic generations; gateways never apply an older generation.

## 20.6 Graceful degradation ladder

State this explicitly so on-call knows what "still fine" looks like:

| Level | Symptom | User impact |
|---|---|---|
| 0 Normal | — | — |
| 1 Degraded control | Deploys slow/queued | Deploys delayed |
| 2 No control plane | Deploys fail, no autoscaling, no cold starts | Existing traffic fine; scaled-to-zero apps down |
| 3 No scheduler | Failed instances not replaced | Gradual capacity decay |
| 4 Gateway degraded | Elevated latency, some 503s | Partial outage |
| 5 Edge down in a region | Region unreachable | Failover to other region |
| 6 Data loss | — | Incident, [§21](../21-disaster-recovery/) |

## 20.7 Registry availability

Because the registry is tier-0 for scale-out:
- Distribution/Zot replicas behind a load balancer, backed by S3 (stateless replicas).
- A read-only mirror per region, synced continuously.
- Worker-local content-addressed cache with generous retention (the last N releases per project on workers that ran them).
- Peer-to-peer layer fetch between workers.
- **Prefetch on release creation** so a scale-up never hits the registry cold.
- Effect: a total registry outage degrades to "no new images can be created, but everything already deployed can scale."
