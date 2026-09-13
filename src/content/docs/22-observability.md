---
title: "22. Observability"
description: "The stack, four user-facing SLOs, the metric catalogue, logs, traces and alerting philosophy."
sidebar:
  order: 22
---

## 22.1 Stack

| Signal | Tool | Rationale |
|---|---|---|
| Metrics | **Prometheus** (per region) + **Thanos** or **Mimir** for global query and long retention | Pull model fits a fleet with service discovery; enormous ecosystem. Thanos/Mimir solves the multi-region + retention problem that plain Prometheus does not |
| Dashboards | **Grafana** | — |
| Logs | **Loki** | Label-indexed, object-storage-backed, cheap. Perfect for high-volume, low-query-rate platform and customer logs. Alternative at scale: ClickHouse or Quickwit if you need full-text search — Loki's weakness is ad-hoc search without good labels |
| Traces | **OpenTelemetry SDK → OTel Collector → Tempo** (or Jaeger) | Tempo is object-storage-backed and pairs with Grafana |
| Instrumentation | **OpenTelemetry everywhere** | Vendor-neutral; lets you swap backends without re-instrumenting. Use OTel for traces and logs; Prometheus client libs for metrics (or OTel metrics exported in Prometheus format) |
| Profiling <span class="mat mat-v1">V1</span> | Pyroscope / Parca (continuous profiling) | Finding a Rust agent's CPU regression across 500 hosts is otherwise miserable |
| Alerting | Alertmanager → PagerDuty/Opsgenie | |
| Status page | Statuspage/Instatus, driven by real SLOs | |

**Two separate telemetry planes.** Platform telemetry (your operations) and customer telemetry (their logs and metrics, shown in their dashboard) have different retention, access control, cardinality, and cost profiles. Keep them in separate Loki tenants and separate Prometheus/Mimir tenants. Never let a customer's log volume affect your ability to debug the platform.

## 22.2 What to measure — the SLO set

Start with four user-facing SLOs; everything else is diagnostic.

| SLO | Definition | Target |
|---|---|---|
| **Request availability** | Non-5xx-originating-from-platform / total, per region | 99.95% monthly |
| **Warm request latency** | p99 platform-added latency (excluding app time) | < 15 ms |
| **Cold start latency** | p95 time from request arrival to first byte for a scaled-to-zero release, by runtime | < 1.5 s (snapshot-enabled) |
| **Deployment success + duration** | p95 git-push → live, for successful deploys | < 3 min |

Distinguish platform errors from app errors rigorously. A customer's app returning 500 is **not** an availability violation; a 503 from the activator timing out **is**. Tag every gateway response with `error_source: app|platform|client`.

## 22.3 Metric catalogue

```text
# Deployment pipeline
helix_deployment_duration_seconds{phase=queue|build|schedule|start|total,runtime,result}
helix_deployment_total{result=succeeded|failed|cancelled,trigger,failure_class}
helix_build_duration_seconds{runtime,cache=hit|miss,result}
helix_build_queue_depth{region}
helix_build_queue_wait_seconds
helix_build_concurrent{region}
helix_image_size_bytes{runtime}
helix_image_pull_duration_seconds{worker,cached}

# Cold start / runtime
helix_cold_start_duration_seconds{runtime,method=cold|snapshot|warm_pool,region}
helix_microvm_start_duration_seconds{phase=rootfs|network|jail|boot|init|probe}
helix_microvm_count{worker,state}
helix_instance_state_transitions_total{from,to,reason}
helix_instance_start_failures_total{reason=pull|boot|probe|oom|capacity}
helix_snapshot_restore_duration_seconds
helix_snapshot_create_duration_seconds
helix_warm_pool_size{worker,runtime}
helix_warm_pool_hit_ratio

# Request path
helix_request_duration_seconds{route,release,method,status_class,phase=total|platform|upstream}
helix_requests_total{release,status,error_source}
helix_request_concurrency{release}
helix_activation_duration_seconds{release,result=hit|timeout}
helix_activation_queue_depth{release}
helix_activation_coalesced_total
helix_upstream_connect_errors_total{worker}
helix_route_table_generation{gateway}
helix_route_table_staleness_seconds{gateway}

# Scheduling
helix_placement_duration_seconds
helix_placement_failures_total{reason=no_capacity|no_match|reservation_conflict}
helix_pending_placements{region,zone}
helix_scheduler_leader{region}
helix_desired_vs_actual_instances{release}

# Worker
helix_worker_cpu_usage_ratio{worker}
helix_worker_memory_allocatable_bytes / _allocated_bytes
helix_worker_steal_time_ratio{worker}
helix_worker_instance_count{worker}
helix_worker_heartbeat_age_seconds{worker}
helix_worker_disk_free_bytes{worker,mount}
helix_worker_rootfs_cache_bytes / _hit_ratio

# Per-tenant (for billing and abuse, cardinality-controlled)
helix_instance_cpu_seconds_total{org,project,release}
helix_instance_memory_mib_seconds_total{org,project,release}
helix_egress_bytes_total{org,project}
helix_requests_billed_total{org,project}

# Control plane
helix_api_request_duration_seconds{endpoint,status}
helix_db_query_duration_seconds{query}
helix_db_pool_saturation
helix_outbox_lag_seconds
helix_queue_depth{subject}
helix_certificate_expiry_seconds{hostname}   # alert < 14d
helix_acme_order_failures_total
```

**Cardinality discipline.** `{org,project,release}` labels on high-frequency metrics will destroy Prometheus. Rules: per-tenant metrics are **aggregated at the agent/gateway into 60 s windows and sent as billing events via NATS, not scraped as Prometheus series**. Prometheus keeps per-release series only for the top-N releases by traffic, or per-project rollups. This is the most common way self-built platforms melt their monitoring.

## 22.4 Logs

| Stream | Source | Destination | Retention |
|---|---|---|---|
| Customer app stdout/stderr | `vminit` → vsock → agent | NATS → Loki (customer tenant) | 7–30 days by plan, then S3 |
| Build logs | Build VM → builder agent | NATS → Loki + S3 | 30 days |
| Platform component logs | Structured JSON with `trace_id` | Loki (platform tenant) | 30 days |
| Audit logs | Postgres (authoritative) + Loki (queryable) | Postgres partitions | 1–7 years |
| Access logs (Envoy/gateway) | Envoy | Loki, sampled for 2xx, full for errors | 30 days |

Labels for customer logs: `org`, `project`, `environment`, `release`, `instance`, `region`, `stream`. Keep it to these — every additional label multiplies stream count.

Customer log API queries always inject `org` server-side. Never build the LogQL query from unsanitized client input (LogQL injection is a real cross-tenant read).

## 22.5 Tracing

Trace context flows: Envoy generates/propagates `traceparent` → gateway adds an activation span → the span is linked to the instance-start span produced by the agent → injected into the guest as `traceparent` so the customer's app can continue the trace if instrumented.

The high-value traces are: **the deployment pipeline** (one trace from API call to instance ready, with spans for build phases, push, scan, placement, pull, boot, probe) and **the cold-start path** (one trace showing exactly where the 1.8 s went). These two traces will answer 80% of "why is it slow" questions. Sample deployments at 100% (low volume, high value) and requests at 0.1–1% plus all errors.

## 22.6 Alerting philosophy

Page only on **symptoms**, not causes:

| Page | Ticket |
|---|---|
| Request availability SLO burn rate > 14.4× (2% budget in 1 h) | A single worker unhealthy |
| p95 cold start > 5 s for 10 min | Build queue depth elevated |
| Deployment success rate < 95% for 15 min | Image cache hit ratio dropped |
| Certificate expiring in < 7 days | Disk 70% full |
| Postgres replication lag > 60 s | A flaky test |
| Pending placements > 0 for 5 min | |
| Any cross-tenant authorization failure detected | |
| Signature verification failure on any worker | |

Use multi-window multi-burn-rate alerting on the SLOs rather than static thresholds. Every alert must link to a runbook; an alert without a runbook gets deleted.
