---
title: "1. Core abstraction and system overview"
description: "Why OCI is the universal artifact, the pipeline stated precisely, the three planes, and the trust boundaries."
sidebar:
  order: 1
---

## 1.1 The central design decision: what is the platform's unit of work?

**Problem.** A platform that wants to support Java, Go, Rust, Python, PHP, Elixir, Swift, .NET and "whatever a customer invents next year" cannot special-case languages. If adding Bun requires a PR to the scheduler, the architecture has already failed. We need one abstraction that everything reduces to.

**Candidate abstractions.**

| Option | What the platform stores and schedules | Consequence |
|---|---|---|
| A. Language-specific bundles (`.zip` of source + a runtime family, Lambda-style) | Per-language packaging, per-language base runtime | Every language is core-platform work. AWS needed a whole "custom runtime API" bolt-on to escape this. Rejected. |
| B. Process + declarative build (Heroku buildpacks / Cloud Native Buildpacks) | A buildpack-produced image | Better, but buildpacks are themselves a large ecosystem to own or vendor, and they constrain users who want full control. Useful *on top of* option C, not instead of it. |
| C. **OCI image** | A content-addressed, layered filesystem + config (entrypoint, env, user, ports) | Universal. Every language already has a first-class story for producing one. Tooling (BuildKit, registries, signing, SBOM, scanning) exists and is mature. |
| D. WASM component | A `.wasm` component with WIT interfaces | Wonderful properties, but does not support the majority of the required language list today. Cannot be *the* abstraction. |

**Decision: OCI image is the universal packaging abstraction. <span class="mat mat-mvp">MVP</span>**

Everything a customer can deploy — a Spring Boot fat jar, a Go binary, a PHP app behind FrankenPHP, a Rust axum server, a hand-written Dockerfile — becomes an OCI image. The platform never knows or cares which language produced it. Language support becomes **data** (a runtime definition file), not **code**.

WASM is a **second, parallel packaging abstraction** for a deliberately narrower workload class ([§8](../08-wasm-architecture/)), not a replacement.

**Tradeoffs of choosing OCI.**

- *Cost:* An OCI image is not directly bootable by a VM. You must convert layers → block device. That conversion is real engineering ([§7.4](../07-firecracker-architecture/#74-oci-image--bootable-rootfs)) and is the piece most people underestimate.
- *Cost:* Image size directly drives cold start. A 900 MB Spring Boot image is a materially worse product than a 40 MB Go image, and customers will blame you, not their Dockerfile.
- *Benefit:* You inherit the entire container ecosystem for free: registries, `docker pull` compatibility, cosign, syft, trivy, layer dedup, and the ability for customers to bring images built elsewhere.
- *Benefit:* Debuggability. "Pull the exact image and run it locally" is a support answer you can actually give.

**Operational implication.** The registry becomes a tier-0 dependency. If the registry is down, no new instance can start anywhere. [§20.7](../20-high-availability/#207-registry-availability) and [§13.4](../13-cold-start-optimization/#134-strategy-3--image-and-filesystem-caching) (aggressive worker-local caching) exist specifically to blunt this.

## 1.2 The pipeline, stated precisely

```text
Source Code           git ref | tarball | prebuilt image reference
      │
      ▼
Build Definition      helix.yaml → resolved against a Runtime Definition
      │
      ▼
Build Environment     BuildKit inside a per-build Firecracker microVM
      │
      ▼
OCI Artifact          image pushed to internal registry, signed, SBOM'd, scanned
      │
      ▼
Execution Definition  immutable ReleaseSpec (image digest + resources + env + health)
      │
      ▼
Runtime               Firecracker microVM  |  Wasmtime instance
      │
      ▼
HTTP/HTTPS            Envoy edge → activator → worker → guest :PORT
```

The critical property: **the Execution Definition is an immutable, fully-resolved document**. No step after it does template expansion, no step after it reads the user's repository, and no step after it needs the control-plane database to make a routing decision for an already-running instance. This is what makes rollback trivial ([§4.7](../04-deployment-pipeline/)) and what keeps the data plane alive when the control plane is down ([§20.4](../20-high-availability/#204-the-autonomy-principle)).

## 1.3 Three planes

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph CP[&quot;Control Plane — Go, stateful via Postgres&quot;]
        API[API Service]
        ORCH[Deployment Orchestrator]
        SCHED[Scheduler]
        ROUTE[Route Publisher / xDS]
        GIT[Git Integration]
        USAGE[Usage &amp;amp; Billing]
    end
    subgraph BP[&quot;Build Plane — ephemeral, untrusted&quot;]
        BQ[Build Queue]
        BW1[Build Worker + BuildKit in microVM]
        REG[(OCI Registry)]
    end
    subgraph DP[&quot;Data Plane — request path, must survive CP outage&quot;]
        EDGE[Envoy Edge]
        ACT[Activator]
        W1[Worker: agent + Firecracker + Wasmtime]
        W2[Worker: agent + Firecracker + Wasmtime]
    end
    subgraph STATE[&quot;Shared State&quot;]
        PG[(PostgreSQL)]
        RD[(Redis)]
        NATS[(NATS JetStream)]
        S3[(S3-compatible Object Storage)]
    end
    DEV[Developer / CLI / Git] --&gt; API
    API --&gt; ORCH --&gt; BQ --&gt; BW1 --&gt; REG
    ORCH --&gt; SCHED --&gt; W1 &amp; W2
    W1 &amp; W2 --&gt;|pull| REG
    SCHED --&gt; ROUTE --&gt; EDGE
    EDGE --&gt; ACT --&gt; W1 &amp; W2
    ACT -.-&gt;|activation request| SCHED
    CP --- PG &amp; RD &amp; NATS
    BP --- NATS &amp; S3
    W1 &amp; W2 -.-&gt;|heartbeat, logs, metrics| NATS
    REG --- S3
    style DP fill:#1f2937,color:#fff
    style CP fill:#1e3a5f,color:#fff
    style BP fill:#4a2c1e,color:#fff</pre></figure>

**The separation rule that matters:** the data plane may *read* state that the control plane publishes, but must never *synchronously depend* on the control plane to serve a warm request. A control plane outage should degrade the platform to "no new deployments, no scale-up," not "site down."

## 1.4 Trust boundaries

There are exactly four, and confusing them is how platforms get owned.

<figure class="mermaid-figure"><pre class="mermaid">graph LR
    subgraph T0[&quot;T0 — Platform trusted&quot;]
        CP2[Control plane, DB, registry, scheduler]
    end
    subgraph T1[&quot;T1 — Semi-trusted&quot;]
        AG[Worker agent, host kernel, Firecracker VMM process]
    end
    subgraph T2[&quot;T2 — Untrusted code, platform-authored env&quot;]
        BK[Build: BuildKit executing customer Dockerfile]
    end
    subgraph T3[&quot;T3 — Fully untrusted&quot;]
        GV[Guest: customer application in microVM / WASM instance]
    end
    T3 --&gt;|vsock, one narrow API| T1
    T2 --&gt;|registry push token, scoped| T0
    T1 --&gt;|mTLS, authenticated| T0
    style T3 fill:#7f1d1d,color:#fff
    style T2 fill:#7c2d12,color:#fff</pre></figure>

- **T3 → T1** is the boundary Firecracker + KVM + seccomp + jailer defends. It is strong but not absolute ([§6.3](../06-runtime-isolation-and-threat-model/#63-what-firecracker-does-and-does-not-solve)).
- **T2 → T0** is the boundary that is most often *under*-defended in real platforms. A customer's `RUN` line executes arbitrary code with network access and a registry credential nearby. Treat build workers as hostile ([§5](../05-build-system/)).
- **T1 → T0** assumes the worker host is not compromised. If it is, that worker's tenants are compromised; the design goal is that the *blast radius stops at that worker* ([§18.5](../18-multi-tenancy/#185-noisy-neighbor-prevention)).

## 1.5 Design principles (used to settle later arguments)

1. **Postgres is the source of truth. Everything else is a cache or a transport.** If a state transition is not in Postgres, it did not happen.
2. **Every state change is a state-machine transition with an explicit guard** ([§38.8](../38-distributed-systems-concerns/#388-deployment-state-machine)). No boolean flags that accrete meaning.
3. **Reconciliation over commands.** The scheduler writes desired state; agents converge actual state and report. Never "fire and forget an RPC and assume it worked."
4. **Idempotency keys on every mutating API and every queue message.** Assume at-least-once delivery everywhere ([§38.1](../38-distributed-systems-concerns/#381-idempotency)).
5. **The data plane degrades, it does not fail.** Stale routes beat no routes.
6. **Security boundaries are physical where possible.** A separate process, a separate VM, a separate host — in that order of preference — beats a separate goroutine.
7. **Build a boring MVP.** Snapshots, multi-region, WASM, and lazy image loading are all V1+ optimizations that are meaningless before the basic loop works.
