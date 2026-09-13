---
title: "3. Compute Plane"
description: "Worker node anatomy, why the agent is Rust, the guest init, and the agent to control-plane protocol."
sidebar:
  order: 3
---

## 3.1 Worker node anatomy

A worker is a bare-metal Linux host (or a metal-class cloud instance) with KVM. It runs exactly one privileged daemon, `helix-agent`, plus the per-VM Firecracker processes that the agent spawns.

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph WORKER[&quot;Worker Node (bare metal, KVM)&quot;]
        direction TB
        AGENT[&quot;helix-agent (Rust, root-ish, systemd)&quot;]
        subgraph SUB[&quot;Agent subsystems (in-process modules)&quot;]
            FCM[Firecracker Manager]
            WASM[WASM Runtime Host]
            IMG[Image Manager]
            NET[Network Manager]
            RES[Resource Manager]
            LOG[Log Collector]
            MET[Metrics Collector]
            HC[Health Checker]
        end
        AGENT --- SUB
        subgraph VMS[&quot;Per-VM processes&quot;]
            J1[&quot;jailer → firecracker #1&quot;] --- V1[&quot;microVM #1&lt;br/&gt;vminit → app&quot;]
            J2[&quot;jailer → firecracker #2&quot;] --- V2[&quot;microVM #2&lt;br/&gt;vminit → app&quot;]
        end
        subgraph WPOOL[&quot;Wasmtime host process pool&quot;]
            WP1[&quot;wasm-host #1: N instances&quot;]
            WP2[&quot;wasm-host #2: N instances&quot;]
        end
        FCM --&gt; J1 &amp; J2
        WASM --&gt; WP1 &amp; WP2
        NET --&gt;|TAP + netns + nftables| V1 &amp; V2
        IMG --&gt;|ext4 rootfs, overlay| V1 &amp; V2
        LOG &lt;-.-&gt;|vsock| V1 &amp; V2
        HC &lt;-.-&gt;|vsock| V1 &amp; V2
    end
    AGENT &lt;--&gt;|gRPC over mTLS| CTRL[helix-control]
    AGENT --&gt;|NATS| TEL[Telemetry pipeline]
    IMG --&gt;|pull| REG[(Registry)]
    GW[helix-gateway] --&gt;|HTTP to instance IP:port| V1 &amp; V2</pre></figure>

## 3.2 Why Rust for the agent

**Problem.** The agent manipulates block devices, network namespaces, cgroup files, seccomp filters, `vsock` sockets, and spawns processes with dropped privileges. It is long-lived, privileged, and parses data that originates from untrusted guests (log streams, health responses).

**Candidates:** Go, Rust, C.

| Criterion | Go | Rust | C |
|---|---|---|---|
| Memory safety at a privileged trust boundary | GC'd, safe, but `cgo` needed for several syscalls | Safe, no GC, direct `nix`/`libc` access | Unsafe |
| Syscall surface (`clone`, `setns`, `unshare`, `mount`, `pivot_root`, seccomp BPF) | Painful: goroutines + `setns` interact badly (namespace is per-*thread*; Go's scheduler moves goroutines between threads). Requires `runtime.LockOSThread` gymnastics or a C constructor trick | Natural. Threads are explicit | Natural |
| Predictable latency / no GC pause during VM boot | GC pauses are small but real at 1000s of VMs | No GC | No GC |
| Ecosystem | Excellent general, weak on VMM | `firecracker` itself is Rust; `rust-vmm` crates, `tokio`, `nix`, `seccompiler` reusable | — |
| Hiring / team familiarity | Easier | Harder | Hardest |

**Decision: Rust for `helix-agent`. <span class="mat mat-mvp">MVP</span>**

The deciding argument is not performance, it is the **namespace-per-thread problem**. Go's runtime multiplexes goroutines across OS threads, and Linux namespaces are a per-thread property. Every container runtime written in Go (runc, containerd) deals with this by re-executing itself as a helper process (`runc init`) or using a C constructor that runs before the Go runtime starts. That is a known, survivable workaround — but you are going to be doing namespace work constantly, and Rust removes an entire class of subtle bug from your most privileged component. Sharing `rust-vmm` crates and being able to read Firecracker's source in the same language is a secondary but real benefit.

**Tradeoff:** slower initial velocity, smaller hiring pool, and you will write more code by hand (Go's stdlib does more for you). Mitigation: keep the agent *small*. It should be a few thousand lines with a narrow surface; all business logic stays in Go.

## 3.3 Agent subsystem responsibilities

## Firecracker Manager
Owns microVM lifecycle. For each instance:
1. Allocate a VM ID, a cgroup, a network slot, and a jail directory (`/srv/jail/{vm_id}`).
2. Hard-link/bind the kernel image and rootfs into the jail.
3. Exec `jailer` with `--uid/--gid` (unprivileged), `--chroot-base-dir`, `--cgroup` settings, `--netns`, and `--` firecracker args.
4. Configure the VM over the Firecracker HTTP API on a unix socket inside the jail ([§7.6](../07-firecracker-architecture/#76-firecracker-api-usage)), or supply a pre-baked JSON config.
5. `InstanceStart` (or `LoadSnapshot` for snapshot restore).
6. Drive health checks over vsock, then mark Ready.
7. On stop: send `SendCtrlAltDel` for graceful shutdown, wait `grace_period`, then SIGKILL the firecracker process; tear down net + block devices; scrub or discard the overlay.

It also maintains the **warm pool** ([§13.2](../13-cold-start-optimization/#132-strategy-1--warm-pools)) and the **snapshot cache** ([§13.1](../13-cold-start-optimization/#131-the-cold-start-budget-decomposed)).

## WASM Runtime Host
Manages a pool of `helix-wasm-host` processes (each a Wasmtime embedder). Responsibilities: load precompiled `.cwasm` modules, maintain instance pools per release, enforce fuel/epoch deadlines and store memory limits, route HTTP requests into `wasi:http/incoming-handler`, recycle instances. Runs as a *separate process from the agent* so a Wasmtime bug cannot compromise the agent directly, and itself sits in a seccomp+namespace sandbox ([§8.5](../08-wasm-architecture/#85-hardening-the-wasm-host)).

## Image Manager
- Resolves an image **digest** (never a tag) to a local rootfs.
- Pulls layers from the registry with a worker-local content-addressed cache (`/var/lib/helix/blobs`, GC'd by LRU with a disk watermark).
- Converts OCI layers → an ext4 image. Two strategies, [§7.4](../07-firecracker-architecture/#74-oci-image--bootable-rootfs).
- Maintains the "rootfs library": `sha256:<config-digest> → /var/lib/helix/rootfs/<digest>.ext4` (read-only, shared by all VMs of that release on this worker).
- Enforces per-image size limits and reports pull duration to metrics.
- <span class="mat mat-v1">V1</span> Lazy loading via an on-demand block device ([§13.5](../13-cold-start-optimization/#135-strategy-4--lazy-image-loading-scale)).

## Network Manager
- Allocates a `/30` (or `/31`) from the node's instance subnet, creates a network namespace per VM, creates a TAP device inside it, wires it to the host bridge or a routed veth pair.
- Installs per-VM nftables rules: egress allowlist/denylist, drop RFC1918 except explicitly allowed, **drop 169.254.0.0/16 unconditionally**, per-VM rate limits via `tc`/HTB, conntrack limits.
- Programs the host-side DNAT so the gateway can reach `worker_ip:assigned_port → 172.16.0.2:app_port`.
- Uses **identical guest-side addressing in every VM** (guest always sees `172.16.0.2/30`, gateway `172.16.0.1`). This is essential for snapshot restore: a restored snapshot has a baked-in IP configuration, so every VM must see the same one. Uniqueness is achieved on the host side, outside the guest's view.

## Resource Manager
- Creates the cgroup v2 hierarchy: `/sys/fs/cgroup/helix/{org}/{release}/{vm}` with `cpu.max`, `cpu.weight`, `memory.max`, `memory.high`, `pids.max`, `io.max`.
- Enforces node-level overcommit policy and admission ([§3.6](#36-node-admission-and-overcommit)).
- Pins vCPU threads to physical cores per tenant-isolation policy ([§6.6](../06-runtime-isolation-and-threat-model/#66-cpu-side-channels-and-smt-policy) — SMT / core scheduling).
- Tracks and publishes node capacity to the scheduler.

## Log Collector
- Reads the guest's stdout/stderr from a dedicated vsock port (guest `vminit` multiplexes them with a framed protocol).
- Applies per-instance rate limiting (e.g. 10k lines/s, 1 MB/s burst) and drops with a visible `[helix] log rate limit exceeded, N lines dropped` marker — never blocks the guest's write, because a blocked log write hangs the customer's app.
- Batches, compresses, and ships to the log pipeline (NATS → Loki). Buffers to local disk with a bounded ring on backpressure.
- Never parses guest content as structured data in the agent process; treat as opaque bytes plus a length prefix.

## Metrics Collector
- Per-VM: CPU time (cgroup `cpu.stat`), memory (`memory.current`, `memory.peak`), network bytes (nftables counters or tc stats), block I/O, VM start duration, in-flight requests (from gateway, correlated).
- Node: utilization, Firecracker process count, pull latency, snapshot restore latency, free memory, thermal/steal.
- Exposes a Prometheus endpoint for node-level scraping **and** publishes per-instance billing events to NATS ([§25.3](../25-billing-and-metering/#253-partial-minute-and-edge-cases)).

## Health Checker
- Drives the configured health probe ([§9.4](../09-universal-runtime-specification/#94-improvements-over-the-naive-version)) over vsock to the guest agent (preferred) or over TCP/HTTP to the instance IP.
- Distinguishes **startup probe** (long deadline, gates Ready) from **liveness** (restarts instance) from **readiness** (removes from routing without killing).

## 3.4 The guest side: `vminit`

Underrated component. Every microVM boots a platform-authored PID 1 written in Rust, statically linked, ~1–2 MB.

Responsibilities:
1. Mount `/proc`, `/sys`, `/dev`, `/tmp` (tmpfs, size-limited), and the writable overlay.
2. Read its configuration from a **vsock handshake** or from the Firecracker MMDS (metadata service) — *not* from the kernel command line, because the cmdline is visible in `/proc/cmdline` to the app and to anyone who gets the rootfs. Secrets must not go on the cmdline.
3. Set hostname, resolv.conf, and the fixed network config.
4. Set up the log pipe: create a pty/pipe pair, connect to host vsock port 10000.
5. Drop privileges to the image's configured `USER` (default `nobody`-equivalent uid 65534 unless the image specifies otherwise and policy allows).
6. Apply an in-guest seccomp profile and `no_new_privs` (defense in depth — this is about limiting what a compromised app can do to *the guest kernel*, which is the VM-escape prerequisite).
7. `exec` the entrypoint. Reap zombies. Forward signals.
8. Serve a control channel on vsock port 10001: `health`, `shutdown`, `snapshot-prepare`, `post-restore`.

**Snapshot hooks are why this component must exist.** After a snapshot restore, the guest has stale entropy, a stale clock, and a stale process-level view of time. `vminit` must, on `post-restore`: re-seed `/dev/urandom` from a host-provided nonce (or rely on VMGenID where the kernel supports it), force an `adjtimex`/PTP clock resync, and notify the app via a well-known hook (e.g. `SIGUSR2` or an in-guest HTTP callback) so language runtimes can reseed their own PRNGs. **Skipping this produces duplicate TLS session keys and duplicate UUIDs across restored VMs** — a genuine security vulnerability, not a cosmetic bug.

## 3.5 Agent ↔ control plane protocol

**Problem.** Thousands of agents need to (a) learn desired state, (b) report actual state, (c) stream logs/metrics, (d) survive control-plane restarts, (e) not stampede.

**Candidates.**

| Option | Assessment |
|---|---|
| REST polling | Simple, but 2k workers × 1s poll = 2k rps of mostly-empty responses, and slow to react |
| **gRPC bidirectional streaming** | Long-lived connection, server pushes desired state, client pushes status; HTTP/2 flow control; native mTLS; codegen for Go server + Rust client (`tonic`) |
| NATS request/reply + subjects | Great for fan-out, but makes the agent depend on NATS availability for control, and adds a broker to the critical path |
| Custom protocol over TLS | No |

**Decision: gRPC bidirectional streaming over mTLS for control; NATS for telemetry. <span class="mat mat-mvp">MVP</span>**

The split matters: control traffic is low-volume, needs strict ordering and delivery guarantees, and benefits from a connection whose liveness *is* the heartbeat. Telemetry is high-volume, lossy-tolerant, and must never back-pressure the control channel.

```protobuf
service WorkerService {
  // Single long-lived stream. Server pushes Assignments; client pushes Reports.
  rpc Session(stream WorkerMessage) returns (stream ControlMessage);

  // Out-of-band, non-blocking
  rpc Register(RegisterRequest) returns (RegisterResponse);
}

message WorkerMessage {
  oneof msg {
    NodeStatus     node_status = 1;   // every 5s: capacity, pressure
    InstanceReport instance    = 2;   // on every state change
    ActivationAck  ack         = 3;
    EventBatch     events      = 4;   // start durations, failures
  }
}

message ControlMessage {
  oneof msg {
    AssignInstance  assign   = 1;   // desired: run release R, N replicas
    StopInstance    stop     = 2;
    DrainNode       drain    = 3;
    PrewarmRequest  prewarm  = 4;
    ReconcileSync   sync     = 5;   // full desired-state snapshot
    ConfigUpdate    config   = 6;
  }
}

message AssignInstance {
  string  instance_id   = 1;   // control-plane-generated, idempotency key
  string  release_id    = 2;
  string  image_digest  = 3;   // sha256:..., never a tag
  Resources resources   = 4;
  repeated EnvVar env   = 5;   // secrets already decrypted, short-lived
  HealthCheck health    = 6;
  RuntimeKind kind      = 7;   // FIRECRACKER | WASM
  int64   deadline_unix = 8;   // give up if not started by then
}
```

**Reconciliation semantics.** `AssignInstance` is a *declaration*, not a command. The agent stores it in local durable state, converges, and reports. On reconnect, the control plane sends `ReconcileSync` with the full desired set; the agent diffs against actual and converges, reporting any instances it holds that the control plane does not know about (orphans → reported, then stopped after a grace period so a control-plane bug does not instantly kill production).

**Backpressure and stampede control.** Each agent has a jittered reconnect (`exp backoff, base 1s, cap 30s, ±30% jitter`). `ReconcileSync` is chunked. The control plane rate-limits assignment fan-out per release to avoid 500 workers simultaneously pulling one image (also mitigated by [§13.4](../13-cold-start-optimization/#134-strategy-3--image-and-filesystem-caching) peer caching).

**Security.** Agent identity is an mTLS client certificate issued at node provisioning, short-lived (24h) and auto-renewed via a SPIFFE-style workload API or a bootstrap token. The control plane authorizes by node identity: a worker can only report about instances assigned to it. A compromised worker cannot read another tenant's secrets because it is never sent them.

## 3.6 Node admission and overcommit

**Problem.** A worker with 256 GB RAM must decide how many 512 MB instances to accept. Accepting exactly 512 wastes the fact that most instances are idle. Accepting 2000 risks OOM cascade.

**Policy <span class="mat mat-v1">V1</span>:**

| Resource | Policy |
|---|---|
| Memory | **No overcommit for the guest's configured maximum.** Sum of `memory.max` ≤ (physical − host reserve − page cache floor). Firecracker memory is backed by anonymous mmap, so the guest only touches what it uses; but a VM that touches its full allocation must not OOM the node. Use `memory.high` below `memory.max` for soft pressure, and **ballooning <span class="mat mat-v1">V1</span>** to reclaim from idle guests. |
| CPU | **Overcommit aggressively**, 4–10× vCPU:pCPU is normal for request-driven serverless. Enforce with `cpu.max` (hard ceiling for the tenant's purchased rate) plus `cpu.weight` (fair share under contention). Monitor steal time; if p99 steal > 5%, reduce the ratio. |
| Disk | Rootfs is shared read-only per release; per-VM overlay is a sparse file with an enforced size (`ext4` on a loop device sized at `ephemeral_storage`, or a thin-LVM volume). Node-level watermark triggers eviction of cold rootfs images. |
| PIDs | `pids.max` per VM is irrelevant (the guest has its own PID space); enforce inside the guest via `vminit` setting `RLIMIT_NPROC` and a guest cgroup. Host-side `pids.max` still caps the Firecracker process's own threads. |
| Network | Per-VM `tc` HTB class with a rate and a burst; conntrack entry cap per VM. |

**Host reserve:** never allocate the last ~8 GB / 10% of RAM and ~2 cores. The host needs page cache for rootfs images (which is a *huge* cold-start lever — a cached rootfs boots from page cache, not disk).

## 3.7 Worker sizing

| Class | Spec | Rough instance capacity @512 MB | Use |
|---|---|---|---|
| Dev | 8 core / 32 GB / NVMe | ~40 | Local / Phase 1 |
| Standard | AMD EPYC 32c/64t, 256 GB, 2×2 TB NVMe, 10 GbE | ~450 | Default V1 worker |
| Dense | EPYC 64c/128t, 512–768 GB, 4×3.84 TB NVMe, 25 GbE | ~1000–1400 | SCALE |
| Build | 32c, 128 GB, 4 TB NVMe (cache), 10 GbE | 8–16 concurrent builds | Build plane |

Firecracker's own published numbers (≈125 ms boot, ≈5 MiB VMM overhead per VM, thousands of VMs per host) are the basis for the density figures. Assume you will do worse initially — budget 3–5 MiB VMM overhead plus your rootfs page-cache footprint, and validate empirically before selling density.

## 3.8 Worker lifecycle

<figure class="mermaid-figure"><pre class="mermaid">stateDiagram-v2
    [*] --&gt; Provisioning: PXE / cloud-init / Ignition
    Provisioning --&gt; Bootstrapping: kernel, KVM, agent installed
    Bootstrapping --&gt; Registering: mTLS identity obtained
    Registering --&gt; Warming: pull base images, build warm pool
    Warming --&gt; Ready
    Ready --&gt; Ready: heartbeat 5s
    Ready --&gt; Cordoned: operator / autoscaler / health degraded
    Cordoned --&gt; Draining: stop accepting; migrate or expire instances
    Draining --&gt; Decommissioned: all instances gone
    Decommissioned --&gt; [*]
    Ready --&gt; Unhealthy: 3 missed heartbeats
    Unhealthy --&gt; Ready: recovered
    Unhealthy --&gt; Fenced: &gt;60s, instances presumed dead
    Fenced --&gt; Draining</pre></figure>

**Draining** is deliberately not "migrate live VMs." Live migration of Firecracker VMs is possible in principle via snapshots but is fragile with active TCP connections. Instead: mark cordoned → route new requests elsewhere → wait for in-flight requests to complete (max `drain_timeout`, default 90s, capped by `request_timeout`) → for min-instance releases, start replacements elsewhere *first*, then stop here.

## 3.9 Agent restart and VM adoption

If the agent crashes or is upgraded, **running microVMs must survive**. This requires:

- Firecracker processes are children of `systemd`, not of the agent — the agent uses `systemd-run --scope` or a small supervisor shim so that agent death does not reap VMs. (Alternative: `PR_SET_CHILD_SUBREAPER` plus double-fork; systemd scopes are cleaner.)
- Agent persists per-VM state (jail path, API socket path, pid, netns, cgroup, instance metadata) to a local embedded DB (`redb`/`sled`/sqlite) *before* starting the VM.
- On start, the agent enumerates persisted VMs, verifies the pid is alive and is a Firecracker process for that jail, re-attaches the vsock log/health connections, and resumes reporting. Anything not adoptable is cleaned up.
- Agent upgrades are therefore a plain `systemctl restart` with a brief (<2s) reporting gap, not a node drain. This matters enormously operationally — otherwise every agent bugfix costs you a full fleet drain.
