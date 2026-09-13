---
title: "32. Production Infrastructure Sizing"
description: "Sizing for small, medium and large production, with the assumptions stated up front."
sidebar:
  order: 32
---

## 32.1 Stated assumptions

**These are planning estimates, not measurements. Every number below depends on workload mix and should be validated with your own load tests before you spend money.**

Assumptions used throughout:
- Average instance: 0.5 vCPU, 512 MiB, ~40% of memory actually touched.
- Average app: 60 requests/minute when active, 30 ms mean response time.
- 70% of deployments are scale-to-zero and idle most of the time.
- Average image: 200 MiB compressed, 450 MiB uncompressed.
- Average build: 90 s, 2 vCPU, 3 GiB.
- Peak/average traffic ratio: 3×.
- vCPU overcommit: 6×. Memory overcommit: 1× (none).
- Worker: 32c/64t EPYC, 256 GiB, 2×2 TB NVMe → ~430 concurrently-running 512 MiB instances at practical density (leaving host reserve and page cache).

## 32.2 Small production — 10 customers, 100 deployments/day

| Resource | Spec | Count | Notes |
|---|---|---|---|
| Runtime workers | 16c/64 GiB metal | 2 | ~100 instances each; 2 for redundancy, not capacity |
| Build workers | 16c/64 GiB, 2 TB NVMe | 1 | 100 builds/day ≈ 2.5 build-hours/day; one is plenty |
| Control plane | 4c/8 GiB VM | 2 | |
| Gateway | 4c/8 GiB VM | 2 | |
| Envoy | co-located with gateway | — | |
| PostgreSQL | 4c/16 GiB, 200 GB SSD | 1 primary + 1 standby | |
| Redis | 2c/4 GiB | 1 + replica | |
| NATS | 2c/4 GiB | 3 | Or skip NATS entirely at this scale and use Postgres queues |
| Object storage | MinIO on 3× 4 TB, or cloud S3 | — | ~2 TB used |
| Registry | co-located, S3-backed | 2 | |
| Monitoring | 8c/32 GiB, 1 TB | 1 | Prometheus + Loki + Grafana |
| **Total** | | **~12–14 machines/VMs** | Single region, 2 zones if available |

Estimated: ~120 physical cores, ~450 GiB RAM, ~15 TB storage, ~5 TB/month egress.

## 32.3 Medium production — 1,000 customers, 10,000 deployments/day

| Resource | Spec | Count | Notes |
|---|---|---|---|
| Runtime workers | 32c/256 GiB metal | 14 | ~5,000 concurrent instances at peak; 14 gives ~25% headroom + 1 failure |
| Build workers | 32c/128 GiB, 4 TB NVMe | 6 | 10k builds/day ≈ 250 build-hours/day ≈ 10.4 concurrent average, 30 at peak → 6 workers × 8 concurrent |
| Control plane | 8c/16 GiB | 6 | 3 per region × 2 regions |
| Gateway | 16c/32 GiB | 8 | Sized by connections, ~50k concurrent each |
| Envoy | 8c/16 GiB | 6 | |
| PostgreSQL | 16c/128 GiB, 2 TB NVMe | 1 primary + 1 sync standby + 1 async replica | ~500 GB data; watch `usage_records` growth |
| Redis | 8c/32 GiB | 3-node HA | |
| NATS | 8c/16 GiB | 5 | |
| Object storage | MinIO 6 nodes × 8×8 TB, or cloud | — | ~150 TB (registry dominates) |
| Registry | 8c/16 GiB | 4 + regional mirrors | |
| Monitoring | 16c/64 GiB + 10 TB | 3 | Prometheus/Mimir, Loki, Tempo |
| **Total** | | **~55–65 machines** | 2 regions |

Estimated: ~900 cores, ~5 TiB RAM, ~200 TB storage, ~120 TB/month egress.

Database load check: 10k deployments/day ≈ 0.12/s average, ~1/s peak — trivial. The database pressure comes from **usage records** (5k instances × 1 row/min ≈ 83 rows/s ≈ 7.2M rows/day) and **instance state transitions**. Partition monthly; consider moving usage to ClickHouse/Timescale around here.

## 32.4 Large production — 100,000 customers, 1,000,000 deployments/day

At this scale the numbers stop being a simple multiplication because you change architecture.

| Resource | Spec | Count | Notes |
|---|---|---|---|
| Runtime workers | 64c/512 GiB dense metal | 350–500 | ~400k concurrent instances peak; spread over 5–8 regions |
| Build workers | 64c/256 GiB, 8 TB NVMe | 150–250 | 1M builds/day ≈ 25,000 build-hours/day ≈ 1,040 concurrent average, ~3,000 peak. **This is the dominant compute cost** and the strongest argument for aggressive caching and `build.network: none` incentives |
| Control plane | 16c/32 GiB | 40+ | |
| Gateway | 32c/64 GiB | 60+ | Rust rewrite likely justified here |
| Envoy | 16c/32 GiB | 40+ | |
| PostgreSQL | 64c/512 GiB, NVMe | Sharded or Citus, 1 primary + standby per shard, per region | Usage data moved out to ClickHouse; consider splitting the "hot" scheduling tables from the "cold" business tables |
| ClickHouse | 32c/128 GiB | 12+ | Usage, metrics, request logs |
| Redis | 32c/128 GiB | Cluster, 12+ | |
| NATS | 16c/32 GiB | 15+ across regions | Kafka likely introduced alongside for the usage/event firehose |
| Object storage | Multi-PB | — | ~5–15 PB with registry GC working well; far more without it |
| Monitoring | dedicated cluster | 30+ | Mimir/Thanos, Loki, Tempo at serious scale |
| **Total** | | **~700–1,000 machines** | 5–8 regions |

Estimated: ~35,000–50,000 cores, ~250 TiB RAM, multi-PB storage, multi-PB/month egress.

**Architecture changes that become necessary here**, not optional:
- Lazy image loading (Nydus) — registry bandwidth and cold-start otherwise dominate.
- Sharded or federated control plane; the single Postgres primary becomes the bottleneck around the scheduling tables.
- Usage/metrics out of Postgres entirely.
- Peer-to-peer image distribution.
- A dedicated build-cache tier.
- Custom edge proxy (Pingora/Rust).
- Automated capacity planning and procurement.

## 32.5 Sizing heuristics you can reuse

```text
runtime_workers  = peak_concurrent_instances / instances_per_worker / (1 - headroom)
                   where headroom ≈ 0.25, instances_per_worker ≈ usable_RAM / instance_RAM

build_workers    = (builds_per_day × avg_build_seconds / 86400) × peak_ratio
                   / concurrent_builds_per_worker

gateway_nodes    = peak_concurrent_connections / 50_000   (Go; ~150k for Rust)

postgres         = sized by WRITE rate of usage_records + instance transitions,
                   not by API traffic

object_storage   = avg_image_size × releases_retained × projects × dedup_factor(≈0.3)
                   + logs + snapshots

egress           = requests × avg_response_size + build downloads + image pulls
```
