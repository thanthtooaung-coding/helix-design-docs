---
title: "14. Storage Architecture"
description: "Ephemeral by default, the storage tiers, and why application state must not live in the microVM."
sidebar:
  order: 14
---

## 14.1 The principle: instances are cattle with amnesia

```text
Application
    │
    ├── read-only rootfs        ← shared, immutable, from the OCI image
    ├── writable overlay        ← ephemeral, destroyed with the instance
    ├── /tmp (tmpfs)            ← ephemeral, in-memory, size-capped
    └── everything durable      ← external services, over the network
```

**Why application state must not live in the microVM:**

1. **Scale-to-zero deletes it.** An app that scales to zero loses any local state, silently. Users who store sessions on disk will experience random logouts and blame you.
2. **Horizontal scaling breaks it.** With 10 instances, a file written by instance 3 is invisible to instances 1–10. Every "it works locally" bug traces here.
3. **Deployments destroy it.** Every deploy replaces instances.
4. **Workers fail.** Local NVMe is not durable.
5. **Snapshots multiply it.** A snapshot taken with local state produces N instances that all believe they own the same "unique" data.
6. **It defeats the isolation model.** Persistent per-tenant volumes on shared hosts create a data-remanence problem (a deleted volume's blocks must be securely erased or encrypted-at-rest with per-tenant keys) and constrain placement (an instance must go where its volume is).

Make this loud in the product: the docs, the CLI, and a startup warning when an app writes more than X MB to the overlay.

## 14.2 The storage tiers

| Tier | Backing | Lifetime | Use |
|---|---|---|---|
| **Instance overlay** | Sparse file / thin LV on worker NVMe, size = `ephemeral_storage` | Instance | Temp files, caches, compiled templates |
| **`/tmp` tmpfs** | Guest RAM (counted against `memory`) | Instance | Fast scratch |
| **Object storage** | S3-compatible (MinIO on-prem, or cloud S3) | Durable | User uploads, build artifacts, snapshots, logs, SBOMs |
| **Managed databases** | External — the user's own Postgres/MySQL/Redis, or a platform add-on | Durable | Application data |
| **Platform KV** *(optional product feature)* | Redis/FoundationDB behind an API | Durable-ish | Small config/session data for serverless apps |
| **Persistent volumes** *(SCALE, opt-in)* | Network block storage (Ceph RBD / cloud EBS) attached as a virtio-blk device | Durable, pinned | Stateful workloads that genuinely need it |

## 14.3 Persistent volumes — if and how

They will be requested. Design constraints if you build them <span class="mat mat-scale">SCALE</span>:

- A volume pins its instance to a zone (network block) or to a host (local NVMe). Local NVMe is much faster but makes the instance non-relocatable — a worker failure means data loss unless replicated.
- **Single-attach only.** Multi-attach requires a cluster filesystem and is a support nightmare. An app with a volume gets `max_instances: 1` and no scale-to-zero-with-data-loss semantics.
- Encrypted at rest with a per-volume key derived from a per-org key in KMS. Deletion = destroy the key (crypto-erase), then reclaim blocks.
- Snapshots and backups become your responsibility, with all the RPO/RTO implications.
- Strongly prefer steering users to object storage and managed databases. "We do not offer persistent disks" is a legitimate, defensible product position for a long time.

## 14.4 Object storage usage

| Bucket | Contents | Lifecycle |
|---|---|---|
| `helix-registry` | OCI blobs and manifests | GC per [§5.10](../05-build-system/#510-artifact-storage-and-the-registry) |
| `helix-uploads` | Source tarballs from CLI deploys | 7 days |
| `helix-build-cache` | Exported BuildKit caches (if registry-backed cache is not used) | 30 days, LRU by project |
| `helix-snapshots` | Firecracker snapshots (encrypted) | Tied to release lifetime |
| `helix-logs` | Cold log archive beyond Loki retention | 90–365 days per plan |
| `helix-sbom` | SBOMs, scan reports, provenance attestations | Retained as long as the image |
| `helix-backups` | Postgres base backups + WAL | Per [§21](../21-disaster-recovery/) |

Self-hosted choice: **MinIO** (or SeaweedFS/Garage) with erasure coding across ≥4 nodes. On cloud, use the provider's S3 but keep the S3 API abstraction so you can move — egress pricing is the main reason you might.
