---
title: "21. Disaster Recovery"
description: "RPO and RTO targets, backup strategy, four restore scenarios, and the DR calendar."
sidebar:
  order: 21
---

## 21.1 Objectives

| Data class | RPO | RTO | Justification |
|---|---|---|---|
| Control-plane database (projects, deployments, secrets, domains) | **0 in-region / ≤ 30 s cross-region** | **≤ 30 min** | Loss means customers cannot manage or redeploy |
| Usage/billing records | **≤ 5 min** | ≤ 4 h | Revenue; also reconstructible from agent/gateway buffers |
| OCI registry (images) | **≤ 15 min** | ≤ 2 h | Images are rebuildable from source, but rebuilding everything is hours; treat as important, not critical |
| Object storage (build artifacts, SBOMs) | ≤ 1 h | ≤ 4 h | |
| Logs | ≤ 1 h, best-effort | ≤ 8 h | Non-critical |
| Snapshots | **No RPO** — regenerable | — | Explicitly disposable |
| Customer application data | N/A | N/A | **Not stored by the platform.** Say this loudly in the docs |
| Serving capability (a region) | — | **≤ 15 min** via failover | |

## 21.2 Backup strategy

**PostgreSQL:**
- Continuous WAL archiving to object storage (pgBackRest or WAL-G) → point-in-time recovery to any second within the retention window.
- Full base backup daily, incremental every 6 h, retained 30 days; one monthly full retained 12 months.
- Backups encrypted with a key that is **not** the same key protecting the database, and stored in a **different account/project** than production, so that a compromised production credential cannot delete backups. Enable object-lock / immutability where available. Ransomware against backups is the scenario that kills companies.
- **Restore tested monthly, automatically**: a job restores the latest backup into a scratch instance, runs schema and row-count assertions, and reports. An untested backup is not a backup.

**Object storage:** versioning on, lifecycle rules, cross-region replication for `helix-registry` and `helix-sbom`. Object-lock on the backup bucket.

**Configuration and infrastructure:** everything in Git (Terraform/OpenTofu for infra, Ansible for host config, Helm/manifests or systemd units for services). Cluster state must be reconstructible from the repo plus the database backup.

**Secrets:** KMS keys are the crown jewels. Multi-region KMS keys; documented key-material backup or an HSM with a quorum-controlled export; **if the CMK is lost, every secret is unrecoverable** — this deserves an explicit, rehearsed procedure and an owner.

**What is deliberately not backed up:** instance overlays, `/tmp`, snapshots, worker local caches, Redis. All reconstructible.

## 21.3 Restore procedures

**Scenario A — accidental deletion of a customer's project.**
Soft-delete with a 30-day window. Restore = clear `deleted_at`, re-create routes, redeploy the last release from its stored image. Automate it; this will happen weekly.

**Scenario B — Postgres corruption or bad migration.**
1. Stop writes (put control plane in read-only mode; the data plane keeps serving).
2. PITR to just before the bad event into a new instance.
3. Validate: row counts, spot-check recent deployments, verify secret decryption works.
4. Repoint, re-enable writes.
5. **Reconcile:** for every release marked active, verify instances exist; for every instance reported by agents, verify a row exists. The agents' actual state is the tiebreaker for runtime; the database is the tiebreaker for intent. Write the reconciliation tool *before* you need it.
Target: 30 min for a database under 500 GB.

**Scenario C — total region loss.**
1. Confirm loss (not a partition) — requires human judgment, with a checklist.
2. Promote the cross-region async replica. Record the data-loss window from `pg_last_wal_receive_lsn` versus the last known primary LSN.
3. Repoint DNS/anycast; withdraw the dead region's routes.
4. Scale workers in the surviving region (or the burst pool).
5. Re-create instances for all active releases — this is the long pole; images must be present in the surviving region's registry mirror (they are, if replication was healthy).
6. Reconcile lost writes: deployments created in the last RPO window are re-driven from the outbox or reported as failed to customers. Be transparent about which.
Target RTO: 15 min to serve, up to 2 h to full capacity.

**Scenario D — compromised signing key or registry.**
1. Revoke the key in KMS; rotate.
2. Re-sign all images from a known-good manifest inventory, or force rebuild.
3. Agents refuse unsigned/old-key images — meaning the fleet stops starting new instances until re-signing completes. Plan for this: keep a key rotation runbook with a grace period where two keys are trusted.

## 21.4 DR calendar

| Exercise | Frequency |
|---|---|
| Automated backup restore verification | Daily |
| Postgres failover drill (in production) | Monthly |
| Region failover game day | Quarterly |
| Full DR from backups into a clean environment | Semi-annually |
| Key rotation drill | Annually |
| Chaos: kill a random worker during business hours | Weekly, automated |
