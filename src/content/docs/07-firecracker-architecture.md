---
title: "7. Firecracker Architecture"
description: "KVM, the VMM, jailer, rootfs conversion, networking, snapshots, and managing thousands of microVMs."
sidebar:
  order: 7
---

## 7.1 Component map

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph HOSTK[&quot;Host&quot;]
        AGENT2[helix-agent]
        JAIL[&quot;jailer (setuid helper)&quot;]
        FC[&quot;firecracker process (VMM)&quot;]
        KVM[&quot;/dev/kvm&quot;]
        TAPD[tap device in netns]
        BLK[&quot;rootfs.ext4 (ro) + overlay.ext4 (rw)&quot;]
        VSOCK[vsock UDS on host]
    end
    subgraph GUEST2[&quot;Guest microVM&quot;]
        GK[guest kernel vmlinux]
        VI[vminit PID 1]
        APP2[customer application]
        GK --&gt; VI --&gt; APP2
    end
    AGENT2 --&gt;|exec| JAIL --&gt;|exec| FC
    FC --&gt;|ioctl KVM_*| KVM
    FC --&gt;|virtio-net| TAPD
    FC --&gt;|virtio-blk| BLK
    FC --&gt;|virtio-vsock| VSOCK
    FC --&gt;|creates vCPU threads| GUEST2
    AGENT2 &lt;--&gt;|HTTP on unix socket| FC
    AGENT2 &lt;--&gt;|vsock: logs, health, control| VI</pre></figure>

## 7.2 The pieces, explained

**KVM** — the Linux kernel module that exposes hardware virtualization (Intel VT-x / AMD-V) through `/dev/kvm`. It handles VM exits, second-level address translation (EPT/NPT), and vCPU scheduling. It is the actual isolation boundary. Requires bare metal or a cloud instance with nested virtualization / metal access.

**VMM (Firecracker)** — a ~50k-line Rust userspace process that owns one microVM. It sets up guest memory (an anonymous `mmap`), creates vCPU threads, loads the kernel, emulates a deliberately tiny device set (virtio-net, virtio-blk, virtio-vsock, virtio-balloon, a serial console, a minimal i8042 for reset), and exposes a control API over a Unix socket. One process per VM — no shared daemon, so a crash kills one VM.

**Guest kernel** — a platform-built `vmlinux` (uncompressed ELF, not bzImage) loaded directly by Firecracker. No bootloader, no BIOS, no UEFI. This is why boot is ~125 ms instead of ~30 s.

**Rootfs** — an ext4 image on a `virtio-blk` device. Read-only base + per-VM writable overlay.

**vCPU** — each vCPU is a host thread running `KVM_RUN`. Pinned by the Resource Manager. `cpu.max` in the cgroup bounds it.

**Memory** — a single anonymous `mmap` of the configured size, faulted in lazily. Hence a 512 MiB VM that uses 80 MiB costs ~80 MiB of host RAM plus ~3–5 MiB VMM overhead. With `virtio-balloon` + free-page-reporting, memory an idle guest frees can be returned to the host.

**TAP networking** — one TAP device per VM inside a per-VM netns ([§6.5](../06-runtime-isolation-and-threat-model/#65-network-isolation)).

**vsock** — a socket family for host↔guest communication that requires no network configuration and cannot be firewalled away by the guest's network stack. Used for logs, health, and control. The host side is a Unix socket; the guest side is `AF_VSOCK` with a port. Critically, **vsock works before the network is up and after it is torn down**, which makes it the right channel for lifecycle control.

**jailer** — Firecracker's setuid helper. It: creates a chroot at `/srv/jail/<id>/root`, moves into a new mount/pid/net namespace, sets uid/gid to an unprivileged per-VM identity, applies a cgroup, drops all capabilities, closes extraneous fds, and then execs `firecracker`. **Always use it.** Running Firecracker directly as root in production is a serious misconfiguration.

**seccomp** — Firecracker installs a default filter on itself restricting the VMM to a few dozen syscalls. Use the default; only write a custom filter if you have a measured need, and review it as security-critical code.

**Snapshots** — Firecracker can pause a VM and serialize (a) device+vCPU state to a small file and (b) guest memory to a file, then restore into a new VM. Restore can be <10 ms with UFFD-backed lazy memory loading. This is the single biggest cold-start lever, and also the biggest correctness trap ([§7.11](#711-snapshot-correctness-hazards--read-this-before-shipping-snapshots)).

## 7.3 VM lifecycle

<figure class="mermaid-figure"><pre class="mermaid">stateDiagram-v2
    [*] --&gt; Allocating: scheduler assigns instance
    Allocating --&gt; RootfsReady: image resolved, ext4 + overlay prepared
    RootfsReady --&gt; NetReady: netns, tap, nftables, DNAT
    NetReady --&gt; Jailed: jailer chroot, cgroup, uid, seccomp
    Jailed --&gt; Configured: PUT boot-source, drives, network, vsock, machine-config
    Configured --&gt; Booting: InstanceStart
    Jailed --&gt; Restoring: LoadSnapshot (fast path)
    Restoring --&gt; Booting
    Booting --&gt; Initializing: vminit handshake over vsock
    Initializing --&gt; Probing: app exec&#x27;d, startup probe running
    Probing --&gt; Ready: probe passed
    Probing --&gt; StartFailed: probe deadline exceeded
    Ready --&gt; Serving: added to route table
    Serving --&gt; Idle: no requests for idle_timeout
    Idle --&gt; Serving: request arrives
    Idle --&gt; Snapshotting: eligible for snapshot
    Snapshotting --&gt; Stopped
    Idle --&gt; Draining: scale-down decision
    Serving --&gt; Draining: deploy / drain / evict
    Draining --&gt; Stopping: in-flight complete or timeout
    Stopping --&gt; Stopped: CtrlAltDel → grace → SIGKILL
    Stopped --&gt; [*]: netns, devices, cgroup, jail reclaimed
    Serving --&gt; Crashed: guest panic / process exit
    Crashed --&gt; [*]
    StartFailed --&gt; [*]</pre></figure>

## 7.4 OCI image → bootable rootfs

**Problem.** Firecracker needs a block device. OCI gives you tar layers. This conversion is the least-discussed and most time-consuming part of building this kind of platform.

**Candidates:**

| Approach | How | Pros | Cons |
|---|---|---|---|
| A. **Flatten to ext4 at pull time** | Pull layers, apply them to a directory, `mkfs.ext4 -d` into a file sized to content + slack | Simple; one artifact per image digest; shared read-only across all VMs of that release; page cache shared | Conversion cost per image per worker (seconds to a minute for large images); disk for both blobs and ext4 |
| B. **devmapper thin snapshots** (what `firecracker-containerd` does) | containerd devmapper snapshotter; each layer is a thin device; VM gets a snapshot device | Incremental, fast per-VM clone, no flattening | devmapper thin-pool operations are a known source of production pain; complex; pool sizing/GC is fiddly |
| C. **Lazy-loading image format** (Nydus / eStargz / SOCI) over a FUSE or NBD-backed block device | Guest reads blocks on demand, fetched from registry/cache | Near-zero time-to-first-byte for huge images; only the ~5% of bytes actually used are fetched | Significant complexity; requires a converted image format; a stall in the backing store stalls the guest; needs a robust local cache |
| D. Virtio-fs passthrough of a host directory | Share a host dir into the guest | No conversion | Much larger host-side attack surface (a filesystem server processing guest requests). **Rejected on security grounds** for untrusted tenants |

**Decision:**
- **<span class="mat mat-mvp">MVP</span> Option A.** Flatten to ext4. Cache `sha256(image_config) → rootfs.ext4` on each worker. Simple, correct, debuggable.
- **<span class="mat mat-v1">V1</span> Option A + aggressive caching + prefetch** ([§13.4](../13-cold-start-optimization/#134-strategy-3--image-and-filesystem-caching)), which gets you most of the way.
- **<span class="mat mat-scale">SCALE</span> Option C** for large images, as an optimization layered on top, not a replacement. Nydus is the most mature choice; budget it as a quarter of work, not a sprint.

Implementation sketch for A (run in the agent, in a mount namespace, never with the guest's content touching host `/`):

```text
1. Resolve digest → manifest → layer descriptors.
2. Pull missing layers into /var/lib/helix/blobs (content-addressed, deduped).
3. mkdir /var/lib/helix/stage/<digest>; untar layers in order with
   whiteout handling, --no-same-owner rejected paths outside root,
   xattr/capability stripping, and a size watchdog.
4. Overlay the platform's guest additions: /sbin/vminit, /etc/resolv.conf
   template, /etc/nsswitch.conf, CA bundle.  (Keep these OUTSIDE the image
   so tenants cannot shadow them — mount vminit from a separate tiny
   read-only device at /helix, and boot init=/helix/vminit.)
5. mkfs.ext4 -F -O ^has_journal -b 4096 -d <stage> -N <inodes> rootfs.ext4
   sized to du + 10% (read-only, so no journal needed, no free-space need).
6. Optionally compute dm-verity hash tree; store root hash alongside.
7. fsync, rename into place, record in the local rootfs index.
```

**Critical detail in step 4:** put `vminit` on a *separate* read-only device, not inside the customer's rootfs. If it lives in the customer's filesystem, a customer image can contain a file at that path and hijack PID 1's identity, and any customer can read the platform's init binary. A separate 2 MB device mounted at `/helix` with `init=/helix/vminit` is clean and unspoofable.

Per-VM overlay creation must be O(1): pre-create a pool of sparse overlay files of standard sizes, or create with `fallocate` + `mkfs.ext4` lazily. Do not `dd` a gigabyte per VM start.

## 7.5 Networking implementation detail

```bash
# Per VM, executed by the Network Manager (illustrative; do it via netlink in Rust)
ip netns add ns-$VMID
ip netns exec ns-$VMID ip tuntap add tap0 mode tap
ip netns exec ns-$VMID ip addr add 172.16.0.1/30 dev tap0
ip netns exec ns-$VMID ip link set tap0 up
# veth pair to host routing namespace
ip link add veth-$VMID type veth peer name veth-h-$VMID netns ns-$VMID   # (naming simplified)
# host side gets a unique /31 from the node pool; guest side stays constant
```

The guest always configures `172.16.0.2/30` with gateway `172.16.0.1`. Uniqueness is on the host side. Host-side nftables does SNAT for egress and DNAT for the gateway's inbound connection to `172.16.0.2:<app_port>`.

MAC addresses are derived deterministically from the VM ID so that snapshot restore does not confuse the guest's ARP cache.

## 7.6 Firecracker API usage

Firecracker exposes a REST API on a Unix socket. Two ways to configure:

| Method | When |
|---|---|
| Sequence of `PUT` calls (`/boot-source`, `/drives/rootfs`, `/drives/overlay`, `/network-interfaces/eth0`, `/vsock`, `/machine-config`, then `PUT /actions {InstanceStart}`) | Dynamic, allows per-VM variation. Slightly slower (several round trips on a UDS — still sub-millisecond) |
| `--config-file` at exec | One-shot, fewer moving parts, good for a fixed template |

**Decision:** use `--config-file` for the common path (the config is fully determined by the ReleaseSpec, so generate JSON and hand it over), and the API socket for runtime operations: `PATCH /machine-config` is not available post-boot, but `PATCH /drives`, `PATCH /balloon`, `PUT /snapshot/create`, and `PUT /actions` are. Keep the API socket open for the VM's lifetime for snapshot and metrics operations.

MMDS (Firecracker's in-VM metadata service at `169.254.169.254` inside the guest): **do not use it for secrets** and consider disabling it entirely, since it collides conceptually with the cloud metadata service you are teaching everyone to block. Use vsock instead — it is unambiguous and cannot be reached by a confused-deputy HTTP client in the app.

## 7.7 Boot budget

Rough target breakdown for a warm-cached, non-snapshot boot:

| Phase | Target |
|---|---|
| Rootfs + overlay + netns + jail setup | 5–15 ms (all cached; no image pull) |
| `jailer` + `firecracker` exec + config | 5–10 ms |
| Guest kernel boot to init | 20–50 ms |
| `vminit` setup + exec app | 3–10 ms |
| **Platform total before app code runs** | **~40–90 ms** |
| Application startup | 5 ms (Go) → 3000+ ms (Spring Boot) |

The platform's share is small and roughly constant. **Application startup dominates**, which is why [§13](../13-cold-start-optimization/) focuses there.

## 7.8 Managing thousands of microVMs per host

Practical constraints and how to handle them:

| Constraint | Issue at scale | Mitigation |
|---|---|---|
| File descriptors | Each VM: API socket, vsock, tap, 2 block devices, log pipes ≈ 10–15 fds | `LimitNOFILE=1048576`; monitor |
| Threads | 1 VMM thread + N vCPU threads + device threads per VM. 2000 VMs × 3 ≈ 6000 threads | `kernel.threads-max`, `pids.max` on the agent's slice; use async I/O in the agent, not thread-per-VM |
| Processes | 2000 firecracker + 2000 jailer-spawned | `kernel.pid_max` raised; systemd slice limits |
| cgroups | 2000+ cgroups | v2 with a shallow hierarchy: `helix.slice/org-<id>.slice/vm-<id>.scope`. Deep hierarchies hurt scheduler performance |
| netns | 2000 network namespaces | Real cost: each is ~100 KB kernel memory plus per-ns conntrack. Consider a shared netns with per-VM nftables rules at very high density, trading isolation strictness — **do not do this for untrusted multi-tenant**; instead cap VMs/host |
| ARP/route tables | Fine with /30 routed links |
| Memory | VMM overhead ~3–5 MiB × 2000 = 6–10 GiB before any guest memory | Budget it explicitly in capacity planning |
| Agent bookkeeping | O(n) scans become hot | Index everything; event-driven not polling; batch reports |
| Teardown storms | Deploy of a 500-instance app | Rate-limit VM stop/start operations per node (e.g. 20 concurrent lifecycle ops), queue the rest |

**Practical density guidance:** plan for 300–800 microVMs per standard worker at 512 MiB configured memory, not 4000. Firecracker's headline density numbers come from tiny VMs with tiny workloads. Measure your own.

## 7.9 Snapshots

**How it works:** `PUT /snapshot/create {snapshot_type: Full|Diff, snapshot_path, mem_file_path}` after `PUT /vm {state: Paused}`. Restore: start a fresh Firecracker with `PUT /snapshot/load {snapshot_path, mem_backend: {backend_type: Uffd, backend_path: ...}, resume_vm: true}`.

With a **UFFD (userfaultfd) memory backend**, the restoring VM does not read the whole memory file up front; the agent serves page faults from a memory-mapped snapshot file (ideally in page cache), so restore latency is ~5–20 ms and memory is faulted in on demand.

**When to snapshot:** after the application has fully started and passed its readiness probe, ideally after a synthetic warmup request or two (so JIT has warmed and lazy initialization has happened). Snapshot once per release per worker, store locally and in object storage.

## 7.10 Snapshot storage economics

A snapshot's memory file is the size of the VM's *touched* memory — for a warmed Spring Boot app, 300–450 MiB. One per release per architecture. With 10k active releases that is multiple TB. Policy:

- Snapshot only releases that are (a) scale-to-zero enabled and (b) have had ≥N cold starts in the last hour, or (c) explicitly opted in.
- Store compressed (zstd) in object storage; keep uncompressed on worker NVMe with LRU.
- Dedupe: memory files of instances of the same release are near-identical; consider a content-defined-chunking store at <span class="mat mat-scale">SCALE</span>.
- Expire with the rollback window.

## 7.11 Snapshot correctness hazards — read this before shipping snapshots

These are real and have bitten real platforms.

| Hazard | Consequence | Mitigation |
|---|---|---|
| **Entropy reuse** | All VMs restored from one snapshot have identical `/dev/urandom` state → identical session keys, UUIDs, CSRF tokens, TLS randoms. A cross-tenant-observable security bug | Use a guest kernel with VMGenID support (Firecracker exposes a VM generation ID device); on restore, the guest kernel reseeds. Additionally `vminit` writes fresh host-provided entropy to `/dev/urandom` and signals the app to reseed. **Test this explicitly.** |
| **Clock skew** | Restored VM believes it is the snapshot time. TLS cert validation fails, tokens appear expired, logs are wrong | On restore, `vminit` sets time from the host via vsock and triggers a PTP/kvm-clock resync. Firecracker snapshot docs require this |
| **Stale TCP connections** | Sockets open at snapshot time are dead after restore | Snapshot only *before* the instance receives real traffic; close all external connections at snapshot-prepare. Apps with pooled DB connections must reconnect — signal them via the post-restore hook |
| **CPU feature mismatch** | Restoring on a different CPU model than the snapshot was taken on can crash the guest (illegal instruction) | Tag snapshots with the CPU template/model; only restore on matching hosts. Use Firecracker CPU templates to normalize features across your fleet — do this from day one or you will repeatedly hit this |
| **Untrusted snapshot loading** | Snapshot files are deserialized by the VMM. A malicious snapshot is an attack on Firecracker | **Never load a snapshot that did not originate from your own platform.** Sign/HMAC snapshot files and verify before load. Never expose "upload your snapshot" as a feature |
| **Secrets baked into memory** | The snapshot memory image contains the env vars and any secret the app loaded | Encrypt snapshots at rest; treat a snapshot file as equivalent in sensitivity to the tenant's secrets; never share snapshots across tenants; invalidate snapshots on secret rotation |
| **Diff snapshot chains** | Long chains slow restore and complicate GC | Cap chain depth; periodically re-base to a full snapshot |

## 7.12 MVP vs V1 vs Scale for Firecracker

| Capability | MVP | V1 | Scale |
|---|---|---|---|
| Boot from ext4 rootfs | ✅ | ✅ | ✅ |
| jailer + seccomp | ✅ (do not skip) | ✅ | ✅ |
| Per-VM netns + nftables | basic | full policy | full |
| vsock control + logs | ✅ | ✅ | ✅ |
| Warm pool | ❌ | ✅ | ✅ |
| Snapshots + UFFD | ❌ | ✅ | ✅ |
| CPU templates | ❌ | ✅ | ✅ |
| Balloon / free-page reporting | ❌ | ✅ | ✅ |
| dm-verity | ❌ | optional | ✅ |
| Lazy image loading (Nydus) | ❌ | ❌ | ✅ |
| Core scheduling | SMT off | ✅ | ✅ |
| arm64 workers | ❌ | optional | ✅ |
