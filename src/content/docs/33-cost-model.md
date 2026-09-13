---
title: "33. Cost Model"
description: "Infrastructure costs by tier and provider, and which optimizations are safe to take."
sidebar:
  order: 33
---

## 33.1 Assumptions and caveats

**These are order-of-magnitude planning figures as of late 2026, in USD/month, and they will be wrong in detail.** Cloud pricing changes constantly, bare-metal pricing varies by region and commitment, and egress pricing dominates in ways that are easy to miss. Use these to compare *shapes*, then get quotes.

Key structural facts that drive everything:
1. **Firecracker requires KVM**, which means bare metal or metal-class instances. You cannot run this on ordinary EC2/GCE shared instances. This eliminates the cheapest cloud tiers.
2. **Metal instances on hyperscalers are expensive.** An `m6i.metal` is roughly $6/hour list (~$4,400/month) for 128 vCPU / 512 GiB. A comparable Hetzner AX162-R (48c/96t EPYC, 256 GiB, 2×1.92 TB NVMe) is roughly €200–250/month. The gap is 10–20×.
3. **Egress pricing is the other 10×.** AWS egress is ~$0.09/GB after the free tier; Hetzner/OVH include tens to hundreds of TB. At 100 TB/month, that is ~$9,000 on AWS versus ~$0 on Hetzner.

Conclusion, stated up front: **for this specific business, dedicated bare metal is the default and hyperscalers are the exception.** Your competitors' unit economics depend on it.

## 33.2 Development

| Item | Option | Monthly |
|---|---|---|
| Dev machine | Existing Windows PC | $0 |
| Worker box | Hetzner AX41 (6c/12t Ryzen, 64 GB, 2×512 GB NVMe) | ~$50 |
| Or: Hetzner AX52 (8c/16t, 64 GB, 2×1 TB NVMe) | | ~$75 |
| Or: Equinix/Latitude on-demand metal (usage-based) | ~$0.50–1.50/hr | ~$100–300 if used heavily |
| Domain + DNS | | ~$2 |
| Object storage (dev) | MinIO on the same box | $0 |
| CI | GitHub Actions free tier + self-hosted runner on the worker box | $0–20 |
| **Total** | | **~$55–100/month** |

A second box for multi-worker testing (Phase 3) adds ~$50. Do not skip this; single-worker testing hides an entire class of bug.

## 33.3 Small production (10 customers, 100 deploys/day)

| Component | Bare metal (Hetzner/OVH) | Hyperscaler (AWS) |
|---|---|---|
| 2× runtime workers (16c/64 GB) | ~$160 | 2× `c6i.metal`-class ≈ $5,000 |
| 1× build worker | ~$90 | ~$1,200 |
| Control plane + gateway (4 small VMs) | ~$80 (cloud VMs) | ~$300 |
| PostgreSQL (primary + standby) | ~$120 self-managed | RDS multi-AZ ~$400 |
| Redis | ~$30 | ElastiCache ~$120 |
| NATS (3 small) | ~$45 | ~$90 |
| Object storage (2 TB) | MinIO on worker disks ≈ $0 | S3 ~$46 |
| Monitoring host | ~$60 | ~$250 |
| Egress (5 TB) | Included | ~$450 |
| Load balancer | ~$10 | ~$25 |
| Backups (off-site) | ~$20 (Backblaze B2/Wasabi) | ~$50 |
| **Total** | **~$600–700/month** | **~$7,900/month** |

## 33.4 Medium production (1,000 customers, 10,000 deploys/day)

| Component | Bare metal | Hyperscaler | Hybrid (recommended) |
|---|---|---|---|
| 14× runtime workers (32c/256 GB) | ~$3,500 | ~$45,000 | ~$3,500 (metal) |
| 6× build workers | ~$1,200 | ~$12,000 | ~$1,200 |
| Control plane (6) + gateway (8) + Envoy (6) | ~$1,000 | ~$2,500 | ~$1,600 (cloud VMs for elasticity) |
| PostgreSQL HA (3 nodes, large) | ~$700 self-managed | RDS ~$3,500 | ~$1,800 (managed for peace of mind) |
| Redis HA | ~$150 | ~$600 | ~$400 |
| NATS (5) | ~$200 | ~$400 | ~$250 |
| Object storage (150 TB) | MinIO: 6× storage nodes ~$1,800 | S3 ~$3,450 + requests | ~$1,800 |
| Monitoring (3 + 10 TB) | ~$500 | ~$2,000 | ~$800 |
| Egress (120 TB) | Included / ~$200 overage | ~$10,800 | ~$500 (metal egress + some cloud) |
| Burst capacity pool | ~$300 (idle metal) | included | ~$600 (on-demand cloud metal) |
| Backups + DR (50 TB off-site) | ~$300 | ~$1,150 | ~$400 |
| CDN for static (optional) | Bunny/Cloudflare ~$200 | CloudFront ~$1,500 | ~$200 |
| **Total** | **~$9,850/month** | **~$82,900/month** | **~$13,050/month** |

The hybrid shape — **compute on dedicated metal, control plane and databases on managed cloud, egress through metal or a cheap CDN** — is the right default. You pay ~30% more than pure metal for meaningfully less operational burden on the stateful pieces, and still come in at ~1/6 of a hyperscaler bill.

## 33.5 Large production (100,000 customers, 1M deploys/day)

| Component | Hybrid / multi-provider metal |
|---|---|
| 400× runtime workers | ~$100,000 |
| 200× build workers | ~$40,000 |
| Control/gateway/Envoy (140 nodes) | ~$25,000 |
| Databases (sharded PG + ClickHouse) | ~$35,000 |
| Redis cluster + NATS + Kafka | ~$12,000 |
| Object storage (8 PB) | ~$60,000–90,000 (own hardware) or ~$180,000 (cloud) |
| Monitoring | ~$20,000 |
| Egress (2 PB) | ~$30,000–60,000 with transit + peering, vs ~$180,000 on a hyperscaler |
| Network (transit, IP space, DDoS protection) | ~$25,000 |
| Multi-region overhead + DR | ~$30,000 |
| **Total** | **~$380,000–450,000/month** |

At this scale you are negotiating transit contracts and considering colocation. The pure-hyperscaler equivalent is comfortably $2M+/month, which is why nobody at this scale runs this workload that way.

## 33.6 Provider comparison for this workload

| Provider | Metal availability | Egress | Best for | Watch out for |
|---|---|---|---|---|
| **Hetzner** | Excellent, cheapest | Generous included | Runtime + build workers, baseline capacity | Limited regions (DE/FI/US/SG), long provisioning, no metal API autoscaling, stricter AUP — **talk to them about running untrusted customer code before you scale** |
| **OVHcloud** | Very good | Generous | Same, more regions incl. EU/CA/APAC | Support quality varies |
| **Equinix Metal / Latitude.sh** | Excellent, **API-driven with fast provisioning** | Metered but reasonable | Burst capacity and regions where you need elasticity | More expensive than Hetzner |
| **Scaleway / Vultr / DigitalOcean** | Some metal | Moderate | Mid-tier regions | Smaller metal catalogs |
| **AWS/GCP/Azure** | `*.metal` instances, expensive | Very expensive | Control plane, managed Postgres, S3, KMS, global network; enterprise customers who require it | Egress will destroy your margins if customer traffic flows through it |
| **Cloudflare** | R2 (zero-egress object storage), CDN, DNS, DDoS | R2 has **no egress fees** | Object storage and the edge — a strong fit for the registry and static assets | Not a compute host for this |

**Recommended shape:** Hetzner/OVH for workers → Cloudflare R2 for the registry and object storage (zero egress is a large structural saving) → a hyperscaler or a good managed provider for Postgres and KMS → Cloudflare or Bunny in front for DDoS protection and static caching → Equinix Metal for burst and for regions the others do not cover.

## 33.7 Cost optimization without weakening isolation

| Lever | Saving | Isolation impact |
|---|---|---|
| Bare metal instead of cloud metal | 10–20× on compute | None |
| Zero-egress object storage (R2) | Large at scale | None |
| arm64 workers where the runtime supports it | 20–40% per unit of compute | None |
| Aggressive image caching + peer distribution | Cuts registry bandwidth and cold starts | None |
| Snapshots (fewer, shorter cold starts) | Reduces wasted compute on repeated boots | None — if entropy/clock handled ([§7.11](../07-firecracker-architecture/#711-snapshot-correctness-hazards--read-this-before-shipping-snapshots)) |
| Scale-to-zero working well | Directly proportional | None |
| CPU overcommit 6–8× | Large | None (cgroups enforce) |
| Build cache hit rate | Build compute is your #2 cost; a 50% → 85% hit rate is worth real money | Only if caches stay per-project |
| Reserved/committed metal contracts | 20–40% | None |
| **Memory overcommit** | Tempting | **Do not.** Ballooning is fine; overcommitting configured maximums risks OOM cascades that take out many tenants |
| **Sharing a kernel (containers) for "low-risk" tenants** | Large | **Do not.** Two isolation tiers means two security models and the weaker one defines your breach |
| **Disabling CPU mitigations** | 10–25% | **Do not.** This is exactly the attack your architecture exists to prevent |
| **Sharing build caches across tenants** | Moderate | **Do not.** Cache poisoning |

The last four are where cost pressure will push you. They are the ones to write down as non-negotiable now, while it is easy.
