---
title: "6. Runtime Isolation and Threat Model"
description: "The threat model, the defense layers, and a flat statement of what Firecracker does and does not solve."
sidebar:
  order: 6
---

## 6.1 Threat model

**Assets, in priority order:**
1. Other tenants' source code, secrets, and running data.
2. Platform credentials (registry keys, KMS keys, DB credentials, cloud IAM).
3. Platform control-plane integrity (ability to deploy on someone else's behalf).
4. Platform availability.
5. Platform reputation / IP address reputation.

**Adversaries:**

| Adversary | Capability | Motivation |
|---|---|---|
| A1. Opportunistic abuser | Signs up with a stolen card, deploys mining/proxy/spam | Money |
| A2. Skilled tenant | Deploys a deliberately malicious workload to escape or pivot | Data theft, ransom |
| A3. External attacker | No account; attacks the edge, API, or a tenant's app | Varies |
| A4. Compromised dependency | Attacker controls an npm/PyPI package a tenant uses | Broad |
| A5. Malicious insider | Platform employee with production access | Data theft |
| A6. Nation-state | 0-days in KVM/Firecracker, hardware side channels | Targeted |

**Explicit assumptions (and their risk):**
- Untrusted code will run with full root privilege *inside its own guest*. Design accordingly. Never treat "the app runs as non-root in the container" as a security control against the tenant themselves — it is a control against *their* app's vulnerabilities, which is still valuable.
- The host kernel and Firecracker are trusted but not invulnerable. A single VM escape is a P0 but must not be a total-platform compromise.
- Multi-tenancy on a single physical host is accepted for cost reasons. This inherently accepts microarchitectural side-channel risk ([§6.6](#66-cpu-side-channels-and-smt-policy)). A "dedicated host" tier exists for customers who cannot accept it.

## 6.2 Defense layers for the Linux (Firecracker) path

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    APP[&quot;Customer application — fully untrusted, may be root in guest&quot;]
    L1[&quot;Guest hardening: non-root user, no_new_privs, guest seccomp, RLIMITs, read-only rootfs&quot;]
    L2[&quot;Guest kernel: minimal config, no modules, no kexec, hardened sysctls&quot;]
    L3[&quot;Firecracker VMM: minimal device model — virtio-net, virtio-blk, virtio-vsock, serial, no PCI/USB/GPU&quot;]
    L4[&quot;Firecracker seccomp filter: ~40 allowed syscalls in the VMM process&quot;]
    L5[&quot;jailer: chroot, unprivileged uid/gid, cgroup, netns, resource limits, no capabilities&quot;]
    L6[&quot;KVM: hardware virtualization — EPT/NPT, VMCS, ring -1 boundary&quot;]
    L7[&quot;Host kernel hardening: lockdown, KSPP sysctls, no unpriv userns, minimal modules, patched&quot;]
    L8[&quot;Host isolation: nftables egress policy, per-VM netns, no host IAM role, SELinux/AppArmor&quot;]
    L9[&quot;Physical / fleet: build ≠ runtime hosts, per-tenant core policy, blast-radius containment&quot;]
    APP --&gt; L1 --&gt; L2 --&gt; L3 --&gt; L4 --&gt; L5 --&gt; L6 --&gt; L7 --&gt; L8 --&gt; L9
    style APP fill:#7f1d1d,color:#fff
    style L6 fill:#14532d,color:#fff</pre></figure>

The load-bearing layer is **L6 (KVM)**. Everything above it reduces the probability of reaching a KVM bug; everything below it reduces the damage if one is found.

## 6.3 What Firecracker does and does not solve

This deserves to be stated flatly, because "we use Firecracker so we're secure" is the most common and most dangerous claim in this space.

**Firecracker meaningfully mitigates:**

| Threat | How |
|---|---|
| Container escape via shared kernel (`runc` CVEs, `/proc` tricks, cgroup escapes, `CAP_SYS_ADMIN` abuse) | There is no shared kernel. The guest has its own |
| Guest→host via device emulation | Minimal device model: no PCI passthrough, no USB, no GPU, no legacy devices, no SCSI, no VGA. Roughly two orders of magnitude less device code than QEMU |
| VMM process compromise → host | jailer: unprivileged uid, chroot, dropped caps, cgroups, netns; plus a seccomp allowlist on the VMM itself. A fully compromised Firecracker process is an unprivileged, jailed, syscall-restricted process |
| Guest kernel exploitation mattering | Guest root is already assumed. Guest kernel compromise does not cross the VM boundary |
| Noisy neighbors (coarse) | Fixed vCPU and memory allocation, cgroup enforcement |
| Filesystem tampering | Read-only rootfs block device shared across VMs; writes go to a per-VM overlay |

**Firecracker does NOT solve:**

| Threat | Why not | Your mitigation |
|---|---|---|
| **KVM / host kernel 0-day** | KVM is a large, privileged codebase. `CVE-2024-…`-class bugs in KVM exist | Patch cadence with live-patching where possible; host kernel hardening; blast-radius containment; detection ([§24.4](../24-abuse-prevention/#244-detecting-a-compromised-platform-host)) |
| **Firecracker 0-day** | Small but non-zero surface (virtio-net/blk/vsock, MMIO, snapshot deserialization) | Keep current; jailer + seccomp as second layer; **never load an untrusted snapshot** ([§7.11](../07-firecracker-architecture/#711-snapshot-correctness-hazards--read-this-before-shipping-snapshots)) |
| **CPU side channels** (Spectre/MDS/L1TF/Downfall/Zenbleed class) | Hardware, not software. SMT sharing lets a guest observe a sibling thread | [§6.6](#66-cpu-side-channels-and-smt-policy): microcode current, mitigations *on* (do not disable for perf), SMT policy, core scheduling |
| **Resource abuse** (mining, DDoS source, spam) | Perfectly legal use of purchased CPU from the VMM's perspective | [§24](../24-abuse-prevention/) |
| **Malicious network behavior / SSRF / metadata theft** | Firecracker happily forwards packets | [§6.5](#65-network-isolation) network isolation is a separate, equally important control |
| **Supply-chain compromise** | Attack is in the artifact, which Firecracker faithfully runs | [§5](../05-build-system/), [§10](../10-custom-runtimes/), signing + SBOM + scanning |
| **Application-layer vulnerabilities** | Not a VM concern | Customer's responsibility; platform provides WAF and secrets hygiene |
| **Data exfiltration by the tenant of their own data** | They own it | N/A |
| **Control-plane compromise** | Entirely outside the VM boundary | [§23](../23-security-architecture/) |
| **Denial of service on the host** (memory pressure, I/O saturation) | Requires explicit cgroup/quota work | [§3.6](../03-compute-plane/#36-node-admission-and-overcommit), [§6.7](#67-resource-abuse-and-dos-containment) |
| **Snapshot-related secret reuse** | Restored VMs share entropy/keys | [§7.11](../07-firecracker-architecture/#711-snapshot-correctness-hazards--read-this-before-shipping-snapshots), [§3.4](../03-compute-plane/#34-the-guest-side-vminit) post-restore hooks |

**Conclusion to carry forward:** Firecracker is necessary and it is the right choice. It is roughly *half* the security story. The other half is network isolation, resource policy, supply chain, and abuse detection — all of which are ordinary engineering work that must be budgeted.

## 6.4 Guest configuration

**Kernel.** Build your own minimal guest kernel. Do not ship a distro kernel.

- Base on a current LTS. Config from Firecracker's recommended microVM config as a starting point.
- Enable only: virtio-net, virtio-blk, virtio-vsock, virtio-mmio, ext4, overlayfs, tmpfs, cgroup v2, seccomp, the required arch bits.
- Disable: modules entirely (`CONFIG_MODULES=n` — removes an entire LPE class), kexec, /dev/mem, /dev/kmem, ftrace for non-root, BPF JIT for unprivileged, `CONFIG_DEVMEM`, ACPI, PCI, USB, sound, graphics, most filesystems, most network protocols (no SCTP/DCCP/RDS/TIPC — historically vulnerable and nobody needs them).
- Enable hardening: `CONFIG_SLAB_FREELIST_RANDOM`, `CONFIG_HARDENED_USERCOPY`, `CONFIG_FORTIFY_SOURCE`, `CONFIG_STACKPROTECTOR_STRONG`, `CONFIG_RANDOMIZE_BASE`, `CONFIG_STRICT_KERNEL_RWX`, `CONFIG_INIT_ON_ALLOC_DEFAULT_ON`.
- Boot args: `reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd random.trust_cpu=on tsc=reliable quiet`. `panic=1` means a guest kernel panic halts the VM immediately, which the agent detects.
- Result: ~2–5 MB kernel, boots in tens of milliseconds.

**Rootfs.**
- Read-only ext4 block device (`virtio-blk`, `ro`), shared by every VM of the same image digest on that worker. Page cache is therefore shared across hundreds of VMs — a major memory and cold-start win.
- Per-VM writable overlay: a second, small, sparse block device with `overlayfs` upper, or `tmpfs` upper if `ephemeral_storage` is small. Destroyed on VM stop.
- `/tmp` is `tmpfs` with an explicit size.
- <span class="mat mat-v1">V1</span> `dm-verity` over the read-only rootfs with the root hash passed by the host: the guest kernel then rejects any tampered block. Protects against a rootfs corrupted on disk and gives a strong integrity statement.

**Guest userspace.** `vminit` ([§3.4](../03-compute-plane/#34-the-guest-side-vminit)) applies:
- `prctl(PR_SET_NO_NEW_PRIVS)`.
- Drop to the image's `USER`, defaulting to uid 65534. Drop all capabilities.
- A default seccomp allowlist that permits normal server workloads but blocks the historically dangerous, rarely-needed set: `kexec_load`, `init_module`, `finit_module`, `delete_module`, `bpf`, `perf_event_open`, `userfaultfd`, `process_vm_readv/writev`, `ptrace` (configurable — some runtimes need it), `mount`, `pivot_root`, `swapon`, `add_key`, `keyctl`, `open_by_handle_at`, `unshare`/`setns` with `CLONE_NEWUSER`. Users can opt out per-project with justification; opting out is logged and does not weaken the VM boundary, only the in-guest boundary.
- `RLIMIT_NPROC`, `RLIMIT_NOFILE`, `RLIMIT_CORE=0`, `RLIMIT_FSIZE`.

Yes, this is defense-in-depth against an attacker who already controls the app. It matters because most compromises are *not* deliberately malicious tenants — they are a tenant's app getting popped by A4 (compromised dependency), and these controls slow the attacker down and generate detectable signals.

## 6.5 Network isolation

This is co-equal with the VM boundary in importance and is frequently neglected.

<figure class="mermaid-figure"><pre class="mermaid">graph LR
    subgraph NETNS[&quot;Per-VM network namespace&quot;]
        TAP[&quot;tap0 — 172.16.0.1/30 (host side)&quot;]
        GUEST[&quot;guest eth0 — 172.16.0.2/30 (identical in every VM)&quot;]
        TAP --- GUEST
    end
    TAP --&gt; NFT{nftables per-VM chain}
    NFT --&gt;|DROP| META[&quot;169.254.0.0/16 — cloud metadata&quot;]
    NFT --&gt;|DROP| PRIV[&quot;10/8, 172.16/12, 192.168/16 — platform VPC&quot;]
    NFT --&gt;|DROP| MC[&quot;multicast, broadcast, non-IP, IP options&quot;]
    NFT --&gt;|DROP| SMTP[&quot;tcp/25,465,587 and known abuse ports&quot;]
    NFT --&gt;|rate-limited SNAT| INET[&quot;Internet via egress NAT pool&quot;]
    NFT --&gt;|allow, specific| DNS[&quot;Platform resolver 172.16.0.1:53 only&quot;]
    GW[&quot;helix-gateway&quot;] --&gt;|DNAT worker_ip:port| GUEST</pre></figure>

Rules, all default-deny:
1. **Identical guest addressing.** Every guest sees `172.16.0.2/30`, gateway `172.16.0.1`, resolver `172.16.0.1`. Uniqueness lives in the host's netns + DNAT, not in the guest. Required for snapshot restore to work at all.
2. **No guest-to-guest traffic**, ever, including same-tenant, unless the tenant explicitly enables a private network feature. There is no bridge that guests share; each is in its own netns with a routed point-to-point link.
3. **Metadata service is dropped unconditionally.** Additionally, the *host* should either have no cloud IAM role or use IMDSv2 with `http-put-response-hop-limit=1`. Belt and braces — this specific attack (SSRF from a customer app → cloud metadata → platform's IAM role) has taken down real platforms.
4. **Platform internals are unreachable.** Control plane, Postgres, Redis, NATS, registry, agent's own ports — all in address ranges the guest cannot route to. The guest's only inbound path is the gateway's DNAT to its app port.
5. **Egress NAT from a dedicated IP pool**, separate from platform IPs, with per-tenant IP assignment at higher tiers so one abuser's reputation damage is contained.
6. **Rate limits:** `tc` HTB on the TAP for bandwidth; nftables `limit` for new connections/sec; conntrack max entries per VM (stops connection-table exhaustion attacks and slows port scanning).
7. **Egress ports:** block 25/465/587 by default (spam), block 445/139 (SMB), 3389; allow 80/443 and general outbound otherwise. Consider default-deny outbound with an allowlist for free-tier accounts (dramatically reduces abuse; upsell paid users to open egress).
8. **DNS through a platform resolver** that logs, rate-limits, blocks known-malicious domains, and prevents DNS-tunneling exfiltration (entropy/QPS heuristics). Block direct UDP/TCP 53 to arbitrary resolvers and block DoH endpoints where feasible.

## 6.6 CPU side channels and SMT policy

**Problem.** Spectre-v2, MDS, L1TF, Downfall, Zenbleed, and successors allow a guest to read data from a sibling hyperthread or from a previously-running context.

**Options:**

| Option | Security | Cost |
|---|---|---|
| Ignore; rely on microcode mitigations | Medium — mitigations handle cross-privilege but SMT co-residency remains a risk | Free |
| **Disable SMT entirely** | High | ~15–30% throughput loss. Expensive at scale |
| **Core scheduling** (Linux `sched_core`, `CLONE_NEWCGROUP`+ `prctl(PR_SCHED_CORE)`), cookie = tenant | High for SMT co-residency | Small scheduling loss; requires kernel 5.14+ and careful setup |
| Dedicated hosts per tenant | Highest | Only viable as a paid tier |

**Decision <span class="mat mat-v1">V1</span>: core scheduling with a per-*tenant* cookie**, so two VMs from different orgs never share a physical core's sibling threads. Keep all microcode and kernel mitigations enabled (do not chase benchmark numbers by disabling them). Offer SMT-disabled and dedicated-host tiers for customers with compliance requirements. **<span class="mat mat-mvp">MVP</span>:** disable SMT on the small initial fleet — it is one line of config and you have capacity to spare.

Also: flush L1D on VM entry where the CPU supports it, keep `spectre_v2=on`, `mds=full,nosmt` semantics via core scheduling, and enable `kvm.nx_huge_pages=auto`.

## 6.7 Resource abuse and DoS containment

| Attack | Containment |
|---|---|
| **Fork bomb** | Inside the guest it exhausts *the guest's* PID space and memory only. `vminit` sets `RLIMIT_NPROC` and a guest cgroup `pids.max`. Host is unaffected. Guest OOM → instance unhealthy → restarted. This is a scenario Firecracker genuinely solves cleanly |
| **Memory bomb** | VM memory is a fixed allocation. Guest OOM killer fires inside the guest; the host never sees pressure — provided you do not overcommit memory ([§3.6](../03-compute-plane/#36-node-admission-and-overcommit)) |
| **Disk fill** | Overlay is a fixed-size device; `tmpfs` has an explicit size. Guest gets ENOSPC |
| **I/O saturation** | cgroup `io.max` on the backing device per VM; separate NVMe namespaces for rootfs cache vs overlays if needed |
| **CPU burn / mining** | Allowed by `cpu.max` up to what is purchased. Detection and billing handle it ([§24.2](../24-abuse-prevention/#242-detection-signals)) |
| **Network flood outbound** | `tc` rate limit, conntrack cap, new-connection rate limit, bandwidth billing, anomaly detection |
| **Request flood inbound** | Gateway-level per-project rate limits and concurrency caps; the tenant's own instances are protected by their `max_instances` |
| **Slowloris against the gateway** | Envoy connection limits, idle timeouts, `max_concurrent_streams`, request-header timeouts |
| **vsock flood** (guest → agent) | Per-VM vsock rate limits in the agent; the log path drops rather than blocks |
| **Deliberate guest kernel panic loop** | `panic=1` halts; agent restart backoff prevents a restart storm |

## 6.8 Isolation for the WASM path

WASM has a *different* threat model and it is important not to assume it is strictly better.

| Layer | Control |
|---|---|
| Wasm linear memory | Bounds-checked by the runtime; no raw pointers to host memory. This is a strong, formally-reasoned boundary |
| Host function surface | WASI preview 2 / `wasi:http`. **Explicitly deny-list:** no `wasi:filesystem` by default, no `wasi:sockets` by default, restricted `wasi:clocks` precision, no `wasi:random` weirdness |
| CPU time | Wasmtime epoch interruption (preferred: cheap) or fuel metering (precise, ~10–30% slower) |
| Memory | `StoreLimits` with a hard `memory_size` cap; pooling allocator with a fixed max instance memory |
| Compilation | **Never compile untrusted wasm on a serving host.** Cranelift is a compiler processing attacker-controlled input. Precompile to `.cwasm` in the build sandbox, sign it, and have the host `deserialize` only signed artifacts |
| Process isolation | `helix-wasm-host` runs as a separate, unprivileged process under seccomp + namespaces, one process per **tenant** (not per instance), so a Wasmtime escape is contained to one tenant |
| Host process compromise | Accepted risk: a Wasmtime sandbox escape gives you one tenant's host process. Mitigated by per-tenant process separation and, at <span class="mat mat-v1">V1</span>, by running the wasm host pool *inside* a Firecracker VM for high-risk tiers |

**Key honest point:** Wasmtime's sandbox is a software boundary in a large JIT compiler. It has had CVEs. It is excellent, but it is not equivalent to hardware virtualization. The right framing is: *WASM gives you cheap isolation between many small workloads; Firecracker gives you strong isolation between untrusted workloads*. For maximum safety, nest them.
