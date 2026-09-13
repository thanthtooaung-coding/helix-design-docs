---
title: "31. Local Development Environment"
description: "Developing this from Windows: WSL2, nested virtualization, and the remote worker setup."
sidebar:
  order: 31
---

## 31.1 The Windows question, answered directly

Firecracker requires `/dev/kvm`. Your options, in order of recommendation:

| Option | Works? | Recommendation |
|---|---|---|
| **A. Dedicated remote Linux bare-metal box as the "worker target," everything else on Windows/WSL2** | Yes | **Recommended.** ~€40–70/month for a Hetzner AX41/AX52 or similar. Real KVM, real performance, matches production, no nested-virt weirdness. Develop locally, sync and run the agent there |
| **B. WSL2 with nested virtualization** | Usually, on Windows 11 with a recent kernel | **Good for convenience, not for truth.** Nested virtualization in WSL2 works on Windows 11 (22H2+) with Intel VT-x or AMD-V exposed; `/dev/kvm` appears once nested virt is enabled. Performance and timing differ from bare metal, and some Firecracker behaviors (snapshot timing, CPU templates, device quirks) are misleading under nesting. Excellent for control-plane, CLI, builder, and dashboard work |
| **C. A Linux VM under Hyper-V or VMware with nested virt enabled** | Yes, with configuration | Equivalent to B, more setup |
| **D. Dedicated local Linux machine (dual boot or a spare box)** | Yes, ideal | Best if you have the hardware. A used workstation with a modern AMD/Intel CPU and 64 GB RAM is a great investment for this project |
| **E. Docker Desktop** | **No** | Docker Desktop's Linux VM does not give you nested KVM in a usable way, and even where it might, you are three layers deep. Use it for Postgres/Redis/registry only |

**Recommended concrete setup for a Windows developer:**

```text
Windows 11 host
├── WSL2 (Ubuntu 24.04)                    ← primary dev environment
│   ├── Go, Rust, Node toolchains
│   ├── docker-compose.dev.yaml            ← postgres, redis, nats, registry, minio, loki, grafana
│   ├── helix-control, helix-gateway, helix-builder, cli, dashboard  ← run here
│   └── (optionally) nested KVM for quick Firecracker smoke tests
│
└── Remote worker box (Hetzner AX41 / used workstation / cloud metal)
    ├── Linux, KVM, bare metal
    ├── helix-agent + vminit + Firecracker    ← the real thing runs here
    └── reachable over WireGuard from WSL2
```

Workflow: `make worker-sync` cross-compiles the agent (`cargo build --target x86_64-unknown-linux-gnu`), rsyncs the binary and the kernel/rootfs artifacts to the box, and restarts the agent. The agent connects back over WireGuard to the control plane running in WSL2. This gives you a fast inner loop with real virtualization.

To enable nested virt in WSL2 (option B), in `.wslconfig`:
```ini
[wsl2]
nestedVirtualization=true
memory=16GB
processors=8
```
then verify inside WSL2 with `ls -l /dev/kvm` and `kvm-ok`. If `/dev/kvm` is absent, check that Hyper-V/virtualization is enabled in firmware and that your WSL kernel is recent (`wsl --update`).

## 31.2 Dev stack

```text
make dev            # brings up docker-compose deps, runs migrations, starts control+gateway+builder with air/watchexec
make worker-sync    # build + deploy agent to the remote worker
make e2e            # run end-to-end tests against the local stack
make seed           # create a dev org, project, and PAT
```

Aim for: **`make dev` on a fresh clone brings up everything except the worker in under 3 minutes.** Everything else about developer velocity follows from this.

For contributors without a KVM box, provide a `--runtime=docker` mode in the agent that runs instances as plain containers instead of microVMs. It is not production-representative and must be loudly marked as insecure, but it lets people work on the control plane, gateway, CLI, and dashboard with no special hardware. Guard it with a build tag so it cannot ship in a release binary.
