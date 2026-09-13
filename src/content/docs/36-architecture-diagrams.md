---
title: "36. Architecture Diagrams"
description: "Ten architecture diagrams from the overall system down to the security boundaries."
sidebar:
  order: 36
---

## 36.1 Overall architecture

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph USERS[&quot;Users&quot;]
        DEV2[Developer: CLI / Dashboard]
        GIT2[GitHub / GitLab / Bitbucket]
        END[End users]
    end
    subgraph EDGE2[&quot;Edge (per region)&quot;]
        ANY[Anycast / GeoDNS]
        ENVOY[Envoy fleet]
        GWY[helix-gateway + activator]
    end
    subgraph CTRL[&quot;Control Plane (per region, writes to primary region)&quot;]
        APIS[API + Auth + Projects + Domains]
        ORCH2[Deployment Orchestrator]
        SCHED2[Scheduler + Autoscaler]
        RPUB[Route Publisher / xDS]
        USG2[Usage Aggregator]
    end
    subgraph BUILD2[&quot;Build Plane&quot;]
        BQ2[(Build queue)]
        BLD[Build workers: BuildKit in microVMs]
        EGP[Egress proxy]
    end
    subgraph COMPUTE[&quot;Compute Plane&quot;]
        W1C[Worker: agent + Firecracker + Wasmtime]
        W2C[Worker: agent + Firecracker + Wasmtime]
        W3C[Worker: ...]
    end
    subgraph DATA2[&quot;Data &amp; Infrastructure&quot;]
        PGX[(PostgreSQL HA)]
        RDX[(Redis)]
        NX[(NATS JetStream)]
        REGX[(OCI Registry)]
        S3X[(S3 Object Storage)]
        KMSX[KMS / HSM]
    end
    subgraph OBS[&quot;Observability&quot;]
        PROM[Prometheus / Mimir]
        LOKI[Loki]
        TEMPO[Tempo]
        GRAF[Grafana + Alertmanager]
    end
    DEV2 --&gt; APIS
    GIT2 --&gt; APIS
    END --&gt; ANY --&gt; ENVOY --&gt; GWY --&gt; W1C &amp; W2C &amp; W3C
    APIS --&gt; ORCH2 --&gt; BQ2 --&gt; BLD --&gt; REGX
    BLD --&gt; EGP
    ORCH2 --&gt; SCHED2 --&gt; W1C &amp; W2C &amp; W3C
    SCHED2 --&gt; RPUB --&gt; ENVOY &amp; GWY
    W1C &amp; W2C &amp; W3C --&gt; REGX
    CTRL --&gt; PGX &amp; RDX &amp; NX &amp; KMSX
    REGX --&gt; S3X
    W1C &amp; W2C &amp; W3C -.-&gt; NX -.-&gt; USG2 --&gt; PGX
    COMPUTE &amp; CTRL &amp; EDGE2 &amp; BUILD2 -.-&gt; PROM &amp; LOKI &amp; TEMPO
    PROM &amp; LOKI &amp; TEMPO --&gt; GRAF</pre></figure>

## 36.2 Control plane internals

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    LB2[Load Balancer] --&gt; ENV3[Envoy API listener]
    ENV3 --&gt; R1[helix-control replica 1]
    ENV3 --&gt; R2[helix-control replica 2]
    ENV3 --&gt; R3[helix-control replica 3]
    subgraph REPLICA[&quot;helix-control (one binary)&quot;]
        direction TB
        H[HTTP/gRPC handlers]
        AZ[authz — single choke point]
        subgraph MODS[&quot;Modules (compile-time boundaries)&quot;]
            M1[auth]
            M2[project]
            M3[deploy]
            M4[domain]
            M5[secret]
            M6[schedule]
            M7[usage]
            M8[notify]
        end
        subgraph PLAT[&quot;platform/&quot;]
            DB2[db + tx + RLS ctx]
            OB[outbox relay]
            IDEM[idempotency]
            KM[kms client]
            TEL[otel]
        end
        H --&gt; AZ --&gt; MODS --&gt; PLAT
    end
    R1 -.-&gt; REPLICA
    subgraph LEAD[&quot;Leader-elected singletons (one active per region)&quot;]
        SCHL[Scheduler + Autoscaler]
        OBR[Outbox relay]
        JAN[Janitors: stale deployments, expired reservations, preview cleanup, cert renewal]
    end
    REPLICA --&gt; LEAD
    PLAT --&gt; PGY[(PostgreSQL)]
    PLAT --&gt; RDY[(Redis)]
    OB --&gt; NY[(NATS)]</pre></figure>

## 36.3 Compute plane

See [§3.1](../03-compute-plane/#31-worker-node-anatomy) for the worker node diagram.

<figure class="mermaid-figure"><pre class="mermaid">graph LR
    subgraph REGION[&quot;Region sin1&quot;]
        subgraph ZA[&quot;Zone A&quot;]
            WA[Worker a1] --- WA2[Worker a2]
        end
        subgraph ZB[&quot;Zone B&quot;]
            WB[Worker b1] --- WB2[Worker b2]
        end
        subgraph ZC[&quot;Zone C&quot;]
            WC[Worker c1]
        end
    end
    SCH3[Scheduler] --&gt;|spread across zones| ZA &amp; ZB &amp; ZC
    GW4[Gateways] --&gt;|prefer local zone,&lt;br/&gt;spill on saturation| ZA &amp; ZB &amp; ZC</pre></figure>

## 36.4 Build pipeline

<figure class="mermaid-figure"><pre class="mermaid">graph LR
    SRC[Source: git / tarball] --&gt; PLAN[Build plan synthesis&lt;br/&gt;helix.yaml + RuntimeDefinition]
    PLAN --&gt; VM2[Per-build Firecracker microVM]
    VM2 --&gt; BK2[BuildKit rootless]
    BK2 --&gt; CACHE[(Per-project cache device)]
    BK2 --&gt; PROXY2[Egress proxy: allowlist]
    PROXY2 --&gt; UPS[npm / PyPI / Maven / crates.io]
    BK2 --&gt; LAYOUT[OCI layout on cache device]
    LAYOUT --&gt; VAL[Validate outside VM:&lt;br/&gt;size, layers, entrypoint, interpreter]
    VAL --&gt; PUSH[Push by digest&lt;br/&gt;single-use scoped token]
    PUSH --&gt; REG2[(Registry)]
    VAL --&gt; SBOM[syft SBOM]
    VAL --&gt; SCAN[trivy scan]
    VAL --&gt; SIGN[cosign sign + SLSA provenance]
    SBOM &amp; SCAN &amp; SIGN --&gt; S32[(Object storage)]
    SIGN --&gt; POL{Admission policy}
    POL --&gt;|pass| REL[Create Release]
    POL --&gt;|fail| FAIL[FAILED_POLICY]</pre></figure>

## 36.5 Firecracker architecture

See [§7.1](../07-firecracker-architecture/#71-component-map).

## 36.6 WASM architecture

See [§8.3](../08-wasm-architecture/#83-architecture).

## 36.7 Networking

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    INET2[Internet] --&gt; ANY2[&quot;Anycast /24 + DDoS scrubbing&quot;]
    ANY2 --&gt; ENV4[&quot;Envoy (public IPs)&quot;]
    ENV4 --&gt;|private network| GW5[helix-gateway]
    GW5 --&gt;|private network| WKN[&quot;Worker host (internal IP)&quot;]
    subgraph WKN2[&quot;Inside the worker&quot;]
        NFT[nftables: DNAT in, SNAT out, policy]
        subgraph NS1[&quot;netns vm-1&quot;]
            T1[tap0 172.16.0.1/30]
            G1[guest 172.16.0.2/30]
        end
        subgraph NS2[&quot;netns vm-2&quot;]
            T2[tap0 172.16.0.1/30]
            G2[guest 172.16.0.2/30]
        end
        NFT --- T1 &amp; T2
    end
    WKN --- NFT
    NFT --&gt;|SNAT from egress IP pool,&lt;br/&gt;rate limited, port/dest filtered| INET2
    NFT -.-&gt;|DROP| MD[&quot;169.254.169.254&lt;br/&gt;RFC1918&lt;br/&gt;platform subnets&quot;]
    G1 -.-&gt;|&quot;no path&quot;| G2</pre></figure>

Note the deliberate duplication of `172.16.0.2` across namespaces — required for snapshot portability ([§6.5](../06-runtime-isolation-and-threat-model/#65-network-isolation)).

## 36.8 Database

See the ER diagram in [§15.2](../15-database-schema/#152-er-diagram).

## 36.9 Multi-region

See [§20.1](../20-high-availability/#201-target-topology).

## 36.10 Security boundaries

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    subgraph B4[&quot;Boundary 4 — Internet&quot;]
        ATT[Anyone]
    end
    subgraph B3[&quot;Boundary 3 — Tenant workload (fully untrusted)&quot;]
        GUEST3[Customer app in microVM]
        WASM3[Customer wasm component]
        BUILDC[Customer build commands]
    end
    subgraph B2[&quot;Boundary 2 — Host (semi-trusted)&quot;]
        AGENTB[helix-agent, host kernel, firecracker, wasm-host]
    end
    subgraph B1[&quot;Boundary 1 — Platform services&quot;]
        CPB2[control plane, gateway, builder coordinator, registry]
    end
    subgraph B0[&quot;Boundary 0 — Crown jewels&quot;]
        KMSB2[KMS keys, signing key, DB primary, backups]
    end
    ATT --&gt;|TLS, WAF, rate limit, authn| CPB2
    ATT --&gt;|TLS, HTTP only| GUEST3
    GUEST3 --&gt;|&quot;KVM + seccomp + jailer + netns&lt;br/&gt;(the hard boundary)&quot;| AGENTB
    WASM3 --&gt;|&quot;Wasmtime sandbox + per-tenant process&lt;br/&gt;(software boundary)&quot;| AGENTB
    BUILDC --&gt;|&quot;KVM + egress proxy + no credentials&quot;| AGENTB
    AGENTB --&gt;|&quot;mTLS, node-scoped authz&quot;| CPB2
    CPB2 --&gt;|&quot;IAM, least privilege, audit&quot;| KMSB2
    style B3 fill:#7f1d1d,color:#fff
    style B2 fill:#78350f,color:#fff
    style B1 fill:#1e3a5f,color:#fff
    style B0 fill:#14532d,color:#fff</pre></figure>
