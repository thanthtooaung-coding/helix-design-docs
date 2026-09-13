---
title: "13. Cold Start Optimization"
description: "Snapshots, warm pools, image caching, lazy loading, and per-language startup figures."
sidebar:
  order: 13
---

## 13.1 The cold-start budget, decomposed

```text
Total cold start = routing overhead
                 + placement decision
                 + artifact availability     ← biggest variance
                 + VM/instance creation
                 + guest boot
                 + application startup       ← biggest absolute cost for most languages
                 + first-request handling (JIT, lazy init, connection pools)
```

Optimize in order of (variance × frequency), which means: artifact availability first, application startup second, VM creation third.

## 13.2 Strategy 1 — Warm pools

Keep pre-booted, *generic* microVMs on each worker: booted guest kernel, `vminit` running, no application yet. Claiming one means: attach the release's rootfs as a second device (hot-plug via `PATCH /drives` is limited — better: the pooled VM boots with a placeholder drive and `vminit` waits on vsock for a "here is your rootfs" message; the agent hot-attaches or the VM uses a lazily-populated device), inject env, `exec` the command.

Realistically, hot-swapping a rootfs into a running VM is fiddly. **Two practical variants:**

| Variant | Mechanism | Saves |
|---|---|---|
| **Generic warm pool** | Pre-booted VMs with the *platform base* rootfs; the release's app files arrive via a second block device attached at boot and mounted by `vminit` on signal | Kernel boot (~50–80 ms) |
| **Per-release warm pool** | For releases with `min_instances: 0` but frequent traffic, keep N fully-started idle instances that the scheduler does not count as "running" for billing-to-user purposes (you eat the cost) | Everything (~0 ms) — this is just min_instances with different accounting |

**Decision:** implement per-release warm instances as `min_instances` (honest and simple), and use generic warm pools only if measurement shows kernel boot is a meaningful share of your cold start. Given app startup usually dominates, **snapshots ([§13.3](#133-strategy-2--firecracker-snapshots-highest-value)) are the higher-value investment.** Pool sizing: `pool_size = f(recent activation rate)`, per worker, capped.

## 13.3 Strategy 2 — Firecracker snapshots (highest value)

Covered mechanically in [§7.9](../07-firecracker-architecture/#79-snapshots)–7.11. The product design:

- Snapshot is taken once per (release, worker, CPU template), after readiness + `snapshot_warmup_requests` synthetic requests.
- Stored locally on NVMe and asynchronously uploaded to object storage so other workers can fetch it.
- Restore uses UFFD so memory pages fault in lazily from page cache → ~10–60 ms to a serving process.
- Post-restore hooks (entropy, clock, reconnect signal) run before the instance is marked ready.

**Expected improvement:** Spring Boot from ~3–8 s to ~50–150 ms. This is the single biggest DX lever in the whole platform and is the reason to build snapshot support properly rather than as an afterthought.

## 13.4 Strategy 3 — Image and filesystem caching

| Technique | Effect |
|---|---|
| **Worker-local blob cache**, content-addressed, LRU with a high watermark | Layers shared across releases and tenants (public base images) are pulled once per worker |
| **Rootfs cache** keyed by image config digest | Conversion cost paid once per worker per image |
| **Page cache warmth** | The read-only rootfs is shared by all VMs of a release; the first VM warms the page cache for the rest. Do not evict aggressively — leave RAM headroom for this |
| **Prefetch on deploy** | When a release is created, push the image to the N workers most likely to host it *before* the first request. Cheap, high impact for scale-to-zero apps |
| **Peer-to-peer layer distribution** | Workers fetch layers from peers (Dragonfly/Kraken-style, or a simple BitTorrent-ish gossip) instead of hammering the registry. Essential when 200 workers scale up one release simultaneously |
| **Registry regional mirrors** | Zot sync or Distribution pull-through per region |
| **Base-image standardization** | Platform run-images share layers across all tenants using that runtime. A tenant's app layer is often < 50 MB while the base is 200 MB — make the base universally cached |

## 13.5 Strategy 4 — Lazy image loading <span class="mat mat-scale">SCALE</span>

Convert images to **Nydus** (or eStargz/SOCI) format at build time; the guest's block device is backed by a host-side daemon that fetches chunks on demand. A 1 GB image typically touches 3–10% of its bytes at startup, so time-to-first-byte becomes near-constant regardless of image size.

Cost: a new image format in your pipeline, a new daemon in the data path, and a hard failure mode (backing store stall = guest I/O stall). Worth it when large images are common; not before.

## 13.6 Strategy 5 — Language-specific optimization

The platform can materially improve startup by shipping good defaults in runtime definitions:

| Runtime | Technique | Effect |
|---|---|---|
| **JVM** | `-XX:TieredStopAtLevel=1` for short-lived, **AppCDS** (`-XX:SharedArchiveFile`) generated at build time, **CRaC** where supported, `-XX:+UseSerialGC` for small heaps, `-XX:MaxRAMPercentage` instead of fixed `-Xmx` | AppCDS alone: 20–40% off JVM startup |
| **JVM, aggressive** | **GraalVM native-image** as an opt-in runtime variant (`runtime.type: java-native`) | 3000 ms → 30 ms, at the cost of long builds and reflection config pain. Offer it, do not default to it |
| **.NET** | ReadyToRun + tiered compilation, or NativeAOT as a variant | 500 ms → 50 ms with NativeAOT |
| **Node.js** | V8 snapshot / `--snapshot-blob` [experimental], bundling to one file (esbuild) to cut module resolution syscalls, `--max-semi-space-size` tuning | Bundling alone can halve startup for large dependency trees |
| **Python** | Precompiled `.pyc` in the image (`compileall` at build), `-X frozen_modules`, avoid heavy imports at module scope, consider `python -X importtime` in build output as a DX feature | 30–50% off for import-heavy apps |
| **Ruby/Rails** | Bootsnap in the image, precompiled assets | Significant |
| **PHP** | FrankenPHP/RoadRunner (persistent worker) instead of PHP-FPM cold per request; opcache with `validate_timestamps=0` and a preloaded script | Large |
| **Go / Rust** | Nothing needed; static binaries, tiny images (`FROM scratch` / distroless) | Already optimal |
| **Elixir/Erlang** | Releases (`mix release`) rather than `mix run`; BEAM starts fast but is memory-hungry | Moderate |
| **WASM** | Precompiled `.cwasm` + Wizer pre-initialization + pooling allocator | Sub-millisecond |

Surface these as **automatic** where safe (AppCDS, `.pyc`, bootsnap) and as **opt-in** where they change semantics (native-image, GraalVM). Report "your cold start is 4.2 s; enabling X would reduce it to ~0.9 s" in the dashboard — that is a genuinely differentiating feature.

## 13.7 Expected cold-start figures

**These are engineering estimates for planning, not measurements. Validate each on your own hardware.** Assumes: rootfs cached locally, warm page cache, 1 vCPU / 512 MiB, small-to-medium app.

| Runtime | Platform overhead | App startup | First-request penalty | **Total cold (no snapshot)** | **Total with snapshot** |
|---|---|---|---|---|---|
| WASM (precompiled, pooled) | 0.1–0.5 ms | ~0 (pre-initialized) | ~0 | **0.1–2 ms** | n/a |
| Go (static binary) | 60–90 ms | 5–20 ms | ~0 | **~80–120 ms** | 15–40 ms |
| Rust (axum/actix) | 60–90 ms | 3–15 ms | ~0 | **~75–110 ms** | 15–40 ms |
| Node.js (bundled, small) | 60–90 ms | 40–120 ms | 10–30 ms | **~120–250 ms** | 20–60 ms |
| Node.js (large dep tree, unbundled) | 60–90 ms | 300–900 ms | 50–150 ms | **~450–1100 ms** | 25–70 ms |
| Python (FastAPI, moderate imports) | 60–90 ms | 200–700 ms | 20–80 ms | **~300–850 ms** | 25–70 ms |
| Ruby on Rails | 60–90 ms | 1500–4000 ms | 200–600 ms | **~2–5 s** | 40–120 ms |
| PHP (FrankenPHP) | 60–90 ms | 50–200 ms | 10–40 ms | **~130–330 ms** | 20–60 ms |
| Java / Spring Boot | 60–90 ms | 2500–8000 ms | 300–1500 ms | **~3–10 s** | 50–150 ms |
| Java / Spring Boot + AppCDS | 60–90 ms | 1800–5000 ms | 300–1000 ms | **~2–6 s** | 50–150 ms |
| Java / GraalVM native | 60–90 ms | 20–60 ms | ~0 | **~90–150 ms** | 20–50 ms |
| .NET 8 (JIT) | 60–90 ms | 300–900 ms | 50–200 ms | **~400–1200 ms** | 30–80 ms |
| .NET NativeAOT | 60–90 ms | 20–60 ms | ~0 | **~90–150 ms** | 20–50 ms |
| Elixir/Phoenix | 60–90 ms | 400–1200 ms | 30–100 ms | **~500–1400 ms** | 40–100 ms |

**Add for a truly cold worker (no cached image):** image pull + rootfs conversion, typically **2–30 s** depending on image size and network. This is why [§13.4](#134-strategy-3--image-and-filesystem-caching) matters more than everything else.

## 13.8 Startup probes and the "is it ready" contract

- **Startup probe** has a long deadline (default 60 s, configurable to 300 s) and does not count toward liveness failures. This is what lets a Spring Boot app boot without being killed.
- Default probe type is TCP connect on the app port — it works for every language with no user configuration. HTTP probes are better (they catch "listening but not initialized") and should be recommended.
- `vminit` additionally reports process exit immediately. An app that exits during startup is failed instantly with its exit code and last 100 log lines, rather than waiting for the probe deadline. This detail massively improves the debugging experience.
