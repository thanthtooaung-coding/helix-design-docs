---
title: "42. Production Readiness Checklist"
description: "The gates to clear before this runs untrusted workloads in production."
sidebar:
  order: 42
---

## Security
- [ ] External penetration test completed; criticals closed
- [ ] All [§39.6](../39-production-security-review/#396-recommended-gates-before-untrusted-signup) gates green
- [ ] Threat model documented and reviewed; owner assigned
- [ ] Image signing enforced at admission on every worker
- [ ] Secrets never on disk, never in logs, never in API responses (verified by test)
- [ ] RLS on all tenant tables; cross-tenant test in CI
- [ ] mTLS between all internal services
- [ ] Encryption at rest: DB, object storage, worker disks, snapshots, backups
- [ ] Key rotation runbook written and rehearsed
- [ ] Audit logging complete and tamper-evident
- [ ] Dependency scanning and patch SLA defined
- [ ] Fleet-wide emergency patch rehearsed (< 24 h)

## Reliability
- [ ] SLOs defined with error budgets and burn-rate alerts
- [ ] Multi-AZ within a region; ≥2 regions for production tier
- [ ] Postgres HA with automatic failover, tested monthly
- [ ] Backup restore verified daily and automatically
- [ ] Region failover game day completed
- [ ] Chaos tests running on a schedule
- [ ] Graceful degradation ladder documented and validated
- [ ] Capacity headroom ≥25% with a documented provisioning lead time
- [ ] Load tested to 10× peak
- [ ] 72-hour soak clean

## Operations
- [ ] Runbook for every page-level alert
- [ ] On-call rotation staffed with an escalation path
- [ ] Dashboards: platform health, per-region, per-worker, deployment funnel, cold start, build queue
- [ ] Log/metric/trace retention defined and enforced
- [ ] Deploy and rollback procedures for every component, rehearsed
- [ ] Emergency kill-switches: per-org, per-region, global new-starts
- [ ] Status page wired to real SLOs
- [ ] Incident process: severity levels, comms templates, postmortem requirement
- [ ] Abuse rotation staffed; `abuse@` monitored with an SLA
- [ ] Infrastructure fully in code; no manual host configuration

## Product and compliance
- [ ] Quotas and rate limits enforced on every plan
- [ ] Metering reconciled against instance records; discrepancy alerting live
- [ ] Spending limits available to customers
- [ ] Billing tested including proration, dunning, and suspension
- [ ] Terms of service and acceptable use policy published
- [ ] DPA, subprocessor list, data deletion and export workflows
- [ ] Data residency flag honored end to end (including logs and backups)
- [ ] Customer-facing docs for every runtime, with working examples
- [ ] Troubleshooting docs for the top 15 failure modes
- [ ] Support tooling with audited impersonation

## Performance
- [ ] Cold start p95 within target per runtime, published
- [ ] Platform-added request latency p99 < 15 ms
- [ ] Deployment p95 < 3 min
- [ ] Build cache hit ratio > 70%
- [ ] Image pull p95 < 5 s at the 90th-percentile image size
- [ ] Performance regression suite with alerting
