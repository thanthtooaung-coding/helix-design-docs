---
title: "8. WASM Architecture"
description: "Wasmtime as a separate deployment type, its mechanics, and the WASM vs Firecracker vs containers tradeoff."
sidebar:
  order: 8
---

## 8.1 The positioning question, answered first

You asked whether WASM should be a first-class runtime, an optimization, or a separate deployment type. The answer changes the whole design, so it goes first.

**Decision: a separate deployment type that is first-class in the product, and never an automatic optimization. <span class="mat mat-v1">V1</span>**

Why not an optimization: you cannot transparently convert a Spring Boot app or a Python app with C extensions into a WASM component. Any system that tries to "automatically use WASM when possible" will succeed for a small subset, fail confusingly for the rest, and produce a product where users cannot predict behavior. The failure mode ("my app works on Firecracker but breaks when the platform decided to use WASM") is unacceptable.

Why not just a niche feature: the workloads WASM serves well — middleware, edge logic, webhooks, transformations, per-request auth, tiny APIs — are genuinely better served by it (sub-millisecond cold start, ~1 MB per instance, thousands per host), and that is a real product differentiator.

So: `runtime.kind: wasm` is a deliberate user choice with clearly documented constraints, surfaced in the CLI as a distinct project type.

**Dogfood first.** Before selling WASM to customers, use it for the platform's own edge middleware (custom headers, redirects, A/B splits, auth checks, request rewriting) in the gateway. That gets the runtime hardened on workloads you control.

## 8.2 When to use WASM instead of Firecracker

| Use WASM when | Use Firecracker when |
|---|---|
| Cold start must be < 5 ms | Cold start of 100–3000 ms is acceptable |
| Workload is request-scoped and mostly stateless | App holds state, background threads, connection pools, schedulers |
| Density matters enormously (10k+ tiny tenants) | Instances are substantial (100 MiB+) |
| Language compiles cleanly to `wasm32-wasip2`: Rust, Go (with TinyGo or Go 1.24+ wasip1/wasip2 support), C/C++, Zig, AssemblyScript, .NET (NativeAOT-LLVM, experimental), JS via a wrapped engine (StarlingMonkey/Javy), Python via componentize-py (large, slow-ish) | Java, Kotlin, Scala, Elixir, Erlang, Ruby, PHP, Swift, Dart, any app with native deps, anything needing threads, `fork`, raw sockets, or a real filesystem |
| Execution is short (< a few hundred ms) | Long-lived processes, WebSockets, streaming, background work |
| You want per-request instance isolation (fresh instance per request) | You want process-level warm state |
| Edge/PoP deployment where per-instance memory is at a premium | Regional deployment |

**Be explicit with users:** "Not every language compiles to WASM" is a documented product constraint, not a bug. A compatibility matrix in the docs with honest status (`supported` / `experimental` / `not supported`) prevents most support load.

## 8.3 Architecture

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    REQ[HTTP request] --&gt; GW2[helix-gateway]
    GW2 --&gt;|route: kind=wasm| WH[&quot;helix-wasm-host (per tenant process)&quot;]
    subgraph WH2[&quot;helix-wasm-host&quot;]
        ENG[&quot;Wasmtime Engine (shared, config-pinned)&quot;]
        MOD[&quot;Module cache: precompiled .cwasm, mmap&#x27;d, signature verified&quot;]
        POOL[&quot;Pooling allocator: preallocated linear memories + tables&quot;]
        subgraph INST[&quot;Per-request&quot;]
            ST[&quot;Store (fuel/epoch deadline, StoreLimits, WASI ctx)&quot;]
            IN[&quot;Instance — wasi:http/incoming-handler&quot;]
        end
        ENG --&gt; MOD --&gt; POOL --&gt; INST
    end
    INST --&gt;|wasi:http/outgoing-handler, allowlisted| EGRESS[Egress proxy]
    INST --&gt; RESP[HTTP response, streamed]
    WH -.-&gt;|metrics, logs| AGENT3[helix-agent]</pre></figure>

## 8.4 Key mechanics

**Component Model + WIT.** Target WASI Preview 2 and the component model, not raw core modules with ad-hoc imports. The contract for an HTTP app is `wasi:http/incoming-handler@0.2.x`, which means:

```wit
// Conceptually, what the platform requires of a wasm deployment
world helix-http {
  import wasi:http/outgoing-handler@0.2.3;   // gated by policy
  import wasi:cli/environment@0.2.3;
  import wasi:clocks/wall-clock@0.2.3;
  import wasi:random/random@0.2.3;
  import wasi:logging/logging;               // platform log sink
  import helix:kv/store;                     // optional platform KV
  export wasi:http/incoming-handler@0.2.3;
}
```

Defining a `world` is what makes this extensible without core changes: a new language is supported the moment its toolchain can produce a component satisfying this world. The platform's ABI is a WIT file in `runtime-definitions/`, versioned.

**Precompilation.** `wasmtime compile` (or `Engine::precompile_component`) produces a `.cwasm` — native code for a specific CPU/OS/Wasmtime version. Do this **in the build sandbox**, not on the serving host, then sign it. At serve time the host uses `Component::deserialize_file` on a signature-verified artifact, which is fast (mmap) and does not run Cranelift on untrusted input.

Consequences you must design for:
- `.cwasm` is tied to `(wasmtime_version, target_triple, cpu_features, engine_config)`. Encode all of that in the artifact key. A Wasmtime upgrade invalidates every `.cwasm` → you need a recompile pipeline and a fallback to JIT-compiling in a sandbox during the transition.
- Build once per target architecture you serve (x86-64-v3, aarch64).

**Pre-initialization (Wizer).** For languages with expensive startup (a JS engine parsing your bundle, a Python interpreter importing modules), run initialization at build time and snapshot the resulting linear memory into the module. This routinely turns a 100 ms JS cold start into ~1 ms. Apply it as a build step in the WASM runtime definition.

**CPU limits.** Two mechanisms:
- *Epoch interruption* (recommended default): a background thread bumps an epoch counter; the guest yields at safe points. ~Free at runtime. Granularity is coarse but adequate for a request deadline.
- *Fuel*: exact instruction accounting, enables precise metering and billing by "work done," but costs ~10–30% throughput.

Use epochs for timeouts, and fuel only for a metered tier where you want to bill per-instruction.

**Memory limits.** `StoreLimitsBuilder::memory_size(n)` plus the pooling allocator's fixed per-instance memory reservation. The pooling allocator preallocates a slab of linear memories with guard pages and reuses them — this is what makes instantiation microsecond-scale. Configure `PoolingAllocationConfig` with explicit `total_memories`, `max_memory_size`, `total_core_instances`; these are hard caps and are your density knob.

**Concurrency model.** One `Store` per request (or per short-lived session). Stores are not `Sync`; run N worker threads, each pulling requests and creating stores. Async host functions (`Config::async_support(true)`) + epoch-based yielding lets a thread multiplex many in-flight requests that are blocked on I/O.

**Filesystem.** Deny by default. Optionally grant a read-only preopen of a bundled assets directory, and a small writable `tmpfs`-like in-memory FS. Never a host path.

**Networking.** `wasi:sockets` denied by default. Outbound HTTP only via `wasi:http/outgoing-handler`, which the host implements — meaning every outbound request passes through your code and your allowlist. This is a *better* egress control point than nftables, because it is at the semantic layer.

**Instance recycling.** Three modes, per-project configurable:
| Mode | Isolation | Perf |
|---|---|---|
| Fresh instance per request (default) | Strongest — no state leaks between requests | Microsecond instantiation makes this cheap |
| Reuse instance for N requests | Weaker; app must not leak state | Slightly faster, keeps app-level caches |
| Long-lived instance | Weakest | Only for trusted / platform middleware |

Default to fresh-per-request. It is the property that makes WASM safe for dense multi-tenancy and it is what customers will get wrong if you let them.

## 8.5 Hardening the WASM host

- One `helix-wasm-host` process **per tenant**, not per instance and not global. A Wasmtime escape then lands in a process that only ever ran that tenant's code.
- That process runs unprivileged, under seccomp, in its own netns and mount ns, with no filesystem access beyond its module cache (read-only, `O_PATH` opened before sandboxing).
- <span class="mat mat-v1">V1</span> For a "high isolation" tier, run the wasm host pool inside a Firecracker microVM. You lose a little density and gain hardware isolation. This is the right place to land for untrusted public workloads; the density is still far better than one VM per app because one VM hosts thousands of wasm instances of *one tenant*.
- Wasmtime config: enable the pooling allocator, disable features you do not need (`wasm_threads(false)` unless required — shared memory complicates isolation), keep `wasm_bulk_memory`, `wasm_simd` as appropriate, and pin the exact Wasmtime version per artifact.
- Patch Wasmtime aggressively. Subscribe to its security advisories. Its CVE history is short but real, and you are running a JIT-compiled sandbox as your only boundary in the non-nested configuration.

## 8.6 Cold start and density expectations

| Metric | WASM (precompiled, pooled) | Firecracker (no snapshot) | Firecracker (snapshot) |
|---|---|---|---|
| Time to first byte, cold | 0.1–2 ms | 120–400 ms + app startup | 10–60 ms + post-restore hooks |
| Memory per idle instance | 1–10 MiB | 40–500 MiB | same |
| Instances per 256 GiB host | 10,000–50,000 | 300–800 | 300–800 |
| Max request duration | Seconds (design for short) | Unbounded | Unbounded |
| Language coverage | Narrow | Complete | Complete |

## 8.7 WASM vs Firecracker vs Containers

| Dimension | Containers (runc/gVisor) | Firecracker microVM | WASM (Wasmtime) |
|---|---|---|---|
| Isolation boundary | Shared host kernel + namespaces/seccomp (gVisor: userspace kernel) | Hardware virtualization (KVM) | Software sandbox in a JIT runtime |
| Isolation strength for untrusted multi-tenant | Weak (runc) / medium (gVisor) | **Strong** | Medium-strong for memory safety; single-runtime-bug risk |
| Cold start | 50–200 ms | 120–400 ms (10–60 ms w/ snapshot) | **0.1–2 ms** |
| Memory overhead per instance | ~1–5 MiB | ~3–5 MiB VMM + guest kernel + guest userspace | **~1 MiB** |
| Density per host | High | Medium | **Very high** |
| Language support | **Everything** | **Everything** | Subset, growing |
| Syscall/OS compatibility | Full Linux | Full Linux | WASI subset only |
| Threads / async | Full | Full | Limited (threads proposal immature) |
| Long-running processes | Yes | Yes | Awkward |
| Filesystem | Full | Full | Capability-scoped, virtual |
| Native dependencies | Yes | Yes | Only if compiled to wasm |
| Snapshot/restore | Checkpoint/restore (CRIU, fragile) | **First-class** | Wizer pre-init at build time |
| GPU / special hardware | Yes | Not practically (no PCI passthrough in Firecracker) | No |
| Operational maturity | Highest | High | Medium |
| Where it wins | Trusted internal workloads; CI | **Untrusted general-purpose apps** | **Untrusted tiny, short, dense workloads** |

**Why containers are rejected as the primary untrusted runtime:** the shared-kernel boundary has a long history of escapes (`runc` CVE-2019-5736, CVE-2024-21626, cgroup release_agent, `/proc/self/exe`), and the Linux kernel's syscall surface is ~350 syscalls of attack surface no seccomp profile fully tames for general workloads. gVisor is a credible middle ground with a smaller escape surface but costs 15–50% on syscall-heavy workloads and has its own compatibility gaps. For a business whose entire premise is running strangers' code, hardware virtualization is worth its cost.

**Note:** containers still appear inside your architecture — as the *packaging format* (OCI) and inside build VMs. The rejection is specifically of container-as-isolation-boundary-for-untrusted-tenants.
