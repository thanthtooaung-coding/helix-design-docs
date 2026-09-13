---
title: "35. Sequence Diagrams"
description: "Eleven sequence diagrams covering deployment, build, VM creation, cold start, rollback and failure."
sidebar:
  order: 35
---

## 35.1 User deployment (end to end)

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    actor Dev
    participant GH as GitHub
    participant API as helix-control (API)
    participant PG as PostgreSQL
    participant NQ as NATS
    participant BW as Build Worker
    participant REG as Registry
    participant SCH as Scheduler
    participant AG as Worker Agent
    participant VM as microVM
    participant RP as Route Publisher
    participant EV as Envoy/Gateway
    Dev-&gt;&gt;GH: git push main
    GH-&gt;&gt;API: webhook push (HMAC signed)
    API-&gt;&gt;API: verify signature, dedupe delivery id
    API-&gt;&gt;PG: tx — INSERT deployment QUEUED, INSERT outbox, COMMIT
    API--&gt;&gt;GH: 200 (within 1s)
    API-&gt;&gt;GH: create check run &quot;queued&quot;
    PG-&gt;&gt;NQ: outbox relay → builds.queue
    NQ-&gt;&gt;BW: deliver job (ack-wait = build timeout)
    BW-&gt;&gt;PG: UPDATE build RUNNING, lease
    BW-&gt;&gt;BW: boot build microVM
    BW-&gt;&gt;GH: clone --depth 1 (short-lived scoped token)
    BW-&gt;&gt;BW: render Dockerfile from runtime definition
    BW-&gt;&gt;BW: BuildKit build (cache mounts, secret mounts)
    BW-&gt;&gt;BW: export OCI layout to cache device
    BW-&gt;&gt;REG: push image by digest (single-use scoped token)
    BW-&gt;&gt;BW: syft SBOM, trivy scan, cosign sign
    BW-&gt;&gt;PG: build SUCCEEDED, image row
    BW-&gt;&gt;NQ: deployment.built
    API-&gt;&gt;PG: create release (immutable ReleaseSpec), state=SCHEDULING
    API-&gt;&gt;SCH: schedule(release)
    SCH-&gt;&gt;PG: filter+score workers, write reservation
    SCH-&gt;&gt;AG: AssignInstance (gRPC stream)
    AG-&gt;&gt;REG: pull image (or local cache hit)
    AG-&gt;&gt;AG: build ext4 rootfs + overlay, netns, tap, nftables
    AG-&gt;&gt;VM: jailer → firecracker → boot
    VM-&gt;&gt;AG: vminit handshake (vsock)
    AG-&gt;&gt;VM: env + secrets over vsock
    VM-&gt;&gt;VM: drop privs, exec app
    AG-&gt;&gt;VM: startup probe
    VM--&gt;&gt;AG: 200 OK
    AG-&gt;&gt;SCH: InstanceReport READY (ip, port)
    SCH-&gt;&gt;RP: release ready
    RP-&gt;&gt;EV: xDS update + Redis route entry (generation N+1)
    RP-&gt;&gt;PG: environment.current_release = rel_X
    API-&gt;&gt;GH: check run &quot;success&quot; + preview/prod URL
    API--&gt;&gt;Dev: notification / CLI stream completes</pre></figure>

## 35.2 Build (detail, including failure)

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    participant NQ as NATS
    participant BC as Builder coordinator
    participant BVM as Build microVM
    participant EP as Egress proxy
    participant UP as Upstream registries
    participant CD as Cache device
    participant REG as Registry
    participant S3 as Object storage
    NQ-&gt;&gt;BC: build job
    BC-&gt;&gt;PG: claim (lease, attempt++)
    BC-&gt;&gt;CD: attach per-project cache device
    BC-&gt;&gt;BVM: boot (rootfs=buildkit image, 2vCPU/4GiB, 20GiB disk)
    BVM-&gt;&gt;BVM: buildkitd (rootless) start
    BC-&gt;&gt;BVM: source + build plan (over vsock)
    BVM-&gt;&gt;EP: npm/maven/pip fetch
    EP-&gt;&gt;EP: allowlist check, bandwidth accounting
    alt host not allowlisted
        EP--&gt;&gt;BVM: 403 (logged, surfaced in build log)
    else allowed
        EP-&gt;&gt;UP: HTTPS
        UP--&gt;&gt;BVM: packages
    end
    BVM-&gt;&gt;CD: write cache
    BVM-&gt;&gt;CD: export OCI layout
    BVM--&gt;&gt;BC: exit 0 + stats
    BC-&gt;&gt;BVM: destroy VM (discard overlay)
    BC-&gt;&gt;BC: validate layout (size, layers, whiteouts)
    BC-&gt;&gt;REG: push by digest (single-use scoped token)
    BC-&gt;&gt;S3: SBOM, scan report, provenance
    BC-&gt;&gt;BC: cosign sign (KMS)
    BC-&gt;&gt;PG: SUCCEEDED
    Note over BVM: failure paths
    alt timeout
        BC-&gt;&gt;BVM: hard kill at wall-clock limit
        BC-&gt;&gt;PG: TIMED_OUT (no auto-retry)
    else guest OOM
        BVM--&gt;&gt;BC: exit 137
        BC-&gt;&gt;PG: FAILED failure_class=user_error, message=&quot;build exceeded 4GiB&quot;
    else worker crash
        Note over BC: lease expires → reaper requeues (attempt ≤ 3)
    else cancel
        NQ-&gt;&gt;BC: cancel signal (also polled from PG every 2s)
        BC-&gt;&gt;BVM: CtrlAltDel → kill
        BC-&gt;&gt;PG: CANCELLED (cache export discarded)
    end</pre></figure>

## 35.3 Firecracker VM creation

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    participant SCH as Scheduler
    participant AG as Agent
    participant IM as Image Manager
    participant NM as Network Manager
    participant RM as Resource Manager
    participant J as jailer
    participant FC as firecracker
    participant K as KVM
    participant VI as vminit
    participant APP as Application
    SCH-&gt;&gt;AG: AssignInstance(instance_id, digest, resources, env, health)
    AG-&gt;&gt;AG: persist assignment to local store (crash-safe)
    AG-&gt;&gt;IM: ensure_rootfs(digest)
    alt cached
        IM--&gt;&gt;AG: /var/lib/helix/rootfs/&lt;digest&gt;.ext4
    else not cached
        IM-&gt;&gt;IM: verify cosign signature
        IM-&gt;&gt;IM: pull layers (registry or peer), flatten, mkfs.ext4
        IM--&gt;&gt;AG: rootfs path
    end
    AG-&gt;&gt;IM: create overlay (sparse, sized)
    AG-&gt;&gt;NM: allocate netns, tap0, /30, nftables, DNAT
    NM--&gt;&gt;AG: host_ip:port → 172.16.0.2:app_port
    AG-&gt;&gt;RM: create cgroup, set cpu.max/memory.max/io.max, core-sched cookie
    AG-&gt;&gt;J: exec jailer(uid, chroot, cgroup, netns) -- firecracker --config-file
    J-&gt;&gt;FC: exec (unprivileged, seccomp, no caps)
    FC-&gt;&gt;K: KVM_CREATE_VM, KVM_CREATE_VCPU, set memory region
    FC-&gt;&gt;FC: load vmlinux, attach virtio-blk ×2, virtio-net, virtio-vsock
    FC-&gt;&gt;K: KVM_RUN (vCPU threads)
    K-&gt;&gt;VI: guest kernel boots → init=/helix/vminit
    VI-&gt;&gt;AG: vsock handshake (port 10001)
    AG-&gt;&gt;VI: config: env, secrets, command, user, limits
    VI-&gt;&gt;VI: mount overlay+tmpfs, netcfg, seccomp, no_new_privs, drop privs
    VI-&gt;&gt;APP: exec
    VI-&gt;&gt;AG: log stream (vsock 10000)
    loop startup probe
        AG-&gt;&gt;APP: TCP/HTTP probe
    end
    APP--&gt;&gt;AG: healthy
    AG-&gt;&gt;SCH: InstanceReport(READY, ip, port, start_duration_ms, method=cold)</pre></figure>

## 35.4 HTTP request (warm path)

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    actor C as Client
    participant EV as Envoy
    participant GW as helix-gateway
    participant WK as Worker (nftables DNAT)
    participant VM as microVM
    participant APP as App
    C-&gt;&gt;EV: GET https://api.acme.com/users (TLS 1.3, H2)
    EV-&gt;&gt;EV: SNI → cert (SDS), route lookup by :authority
    EV-&gt;&gt;EV: rate limit, body limit, add x-request-id + traceparent
    EV-&gt;&gt;GW: forward (or direct to instance if always-on)
    GW-&gt;&gt;GW: route table lookup → ready endpoints
    GW-&gt;&gt;GW: least-request pick, increment in-flight counter
    GW-&gt;&gt;WK: HTTP/1.1 to worker_ip:assigned_port
    WK-&gt;&gt;VM: DNAT → 172.16.0.2:8080
    VM-&gt;&gt;APP: request
    APP--&gt;&gt;VM: 200 + body
    VM--&gt;&gt;GW: response (streamed)
    GW-&gt;&gt;GW: decrement counter, record duration + bytes (in-memory)
    GW--&gt;&gt;EV: response
    EV--&gt;&gt;C: 200
    Note over GW: every 60s → usage event to NATS (no per-request DB write)</pre></figure>

## 35.5 Cold start (scale-to-zero activation)

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    actor C as Client
    participant EV as Envoy
    participant GW as helix-gateway
    participant RD as Redis
    participant SCH as Scheduler
    participant AG as Agent
    participant VM as microVM
    C-&gt;&gt;EV: GET https://cold.helix.app/
    EV-&gt;&gt;GW: forward
    GW-&gt;&gt;GW: lookup → 0 ready endpoints, scale_to_zero=true
    GW-&gt;&gt;RD: SETNX activating:rel_X (TTL 30s)
    alt won single-flight
        RD--&gt;&gt;GW: OK
        GW-&gt;&gt;SCH: Activate(rel_X, reason=request, queued=1)
        SCH-&gt;&gt;SCH: place (prefer worker with snapshot)
        SCH-&gt;&gt;AG: AssignInstance(method=snapshot)
        AG-&gt;&gt;VM: LoadSnapshot + UFFD memory backend, resume
        VM-&gt;&gt;VM: post-restore: reseed entropy, resync clock, notify app
        AG-&gt;&gt;VM: readiness probe
        VM--&gt;&gt;AG: healthy
        AG-&gt;&gt;SCH: READY
        SCH--&gt;&gt;GW: endpoint push
    else lost single-flight
        RD--&gt;&gt;GW: exists
        GW-&gt;&gt;GW: join waiters for rel_X
    end
    par other concurrent requests
        C-&gt;&gt;EV: 200 more requests
        EV-&gt;&gt;GW: forward
        GW-&gt;&gt;GW: enqueue (bounded), report concurrency → scheduler scales to N
    end
    alt ready within cold_start_budget
        GW-&gt;&gt;VM: replay buffered request
        VM--&gt;&gt;GW: 200
        GW--&gt;&gt;C: 200 (x-helix-cold-start: 84ms)
    else budget exceeded
        GW--&gt;&gt;C: 503 Retry-After: 2, x-helix-reason: activation_timeout
    end</pre></figure>

## 35.6 Warm request with concurrent scale-up

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    participant GW as Gateways (N replicas)
    participant RD as Redis
    participant AS as Autoscaler
    participant SCH as Scheduler
    participant AG as Agents
    loop every 1s
        GW-&gt;&gt;RD: publish in-flight count per release
    end
    loop every 2s
        AS-&gt;&gt;RD: read aggregate concurrency for rel_X = 340
        AS-&gt;&gt;AS: desired = ceil(340/50) = 7, current = 3
        AS-&gt;&gt;AS: panic check: 7 &gt; 2×3 → panic mode, scale immediately
        AS-&gt;&gt;SCH: set desired(rel_X) = 7
        SCH-&gt;&gt;SCH: place 4 new instances (P2C + cache affinity)
        SCH-&gt;&gt;AG: AssignInstance ×4 (rate-limited to 20 concurrent per release)
        AG--&gt;&gt;SCH: READY (staggered)
        SCH-&gt;&gt;GW: endpoint updates (generation++)
    end
    Note over GW: new endpoints enter least-request rotation immediately,&lt;br/&gt;no request is held because instances already existed</pre></figure>

## 35.7 Scale to zero

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    participant GW as Gateway
    participant AS as Autoscaler
    participant SCH as Scheduler
    participant AG as Agent
    participant VM as microVM
    participant S3 as Object storage
    Note over GW: last request completes at T
    loop every 2s
        AS-&gt;&gt;AS: concurrency = 0, min_instances = 0
    end
    Note over AS: T + 60s (scale_down_delay), still zero
    AS-&gt;&gt;SCH: set desired(rel_X) = 0
    SCH-&gt;&gt;GW: mark route cold (generation++), remove endpoints
    SCH-&gt;&gt;AG: StopInstance(graceful)
    AG-&gt;&gt;VM: pre_stop hook, then SIGTERM via vsock
    VM-&gt;&gt;VM: app drains (up to stop_grace_period)
    alt snapshot policy allows and no snapshot exists
        AG-&gt;&gt;VM: pause
        AG-&gt;&gt;AG: create snapshot (state + mem)
        AG-&gt;&gt;S3: upload encrypted snapshot (async)
    end
    AG-&gt;&gt;VM: SendCtrlAltDel → wait → SIGKILL
    AG-&gt;&gt;AG: tear down netns, overlay, cgroup, jail
    AG-&gt;&gt;SCH: InstanceReport STOPPED
    SCH-&gt;&gt;PG: instances.stopped_at, stop_reason=scale_to_zero
    Note over AG: rootfs + snapshot retained on this worker (affinity for next activation)
    Note over AS: flap detector: if 0↔1 &gt; N times/hour → pin min_instances=1, notify user</pre></figure>

## 35.8 Rollback

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    actor Dev
    participant API as API
    participant PG as PostgreSQL
    participant SCH as Scheduler
    participant AG as Agent
    participant RP as Route Publisher
    Dev-&gt;&gt;API: POST /deployments/{id}/rollback
    API-&gt;&gt;PG: resolve target release rel_prev, verify image digest still present
    API-&gt;&gt;API: compute env diff, include in response
    API-&gt;&gt;PG: INSERT deployment(trigger=rollback, state=SCHEDULING)
    alt rel_prev still has ready instances (within drain window)
        API-&gt;&gt;RP: switch alias production → rel_prev
        RP-&gt;&gt;RP: route generation++ (sub-second)
        API-&gt;&gt;PG: deployment ACTIVE
    else no instances
        API-&gt;&gt;SCH: schedule(rel_prev) from stored ReleaseSpec (no rebuild)
        SCH-&gt;&gt;AG: AssignInstance (snapshot likely cached → fast)
        AG--&gt;&gt;SCH: READY
        SCH-&gt;&gt;RP: switch alias
        RP-&gt;&gt;RP: generation++
    end
    API-&gt;&gt;PG: audit log (actor, reason, from→to)
    API-&gt;&gt;GH: commit status on the rolled-back-to commit
    API--&gt;&gt;Dev: 202 → ACTIVE
    Note over SCH: previous (bad) release drained after drain_timeout, image retained</pre></figure>

## 35.9 Worker failure

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    participant AG as Agent (worker-7)
    participant SCH as Scheduler
    participant GW as Gateway
    participant PG as PostgreSQL
    participant AG2 as Agent (worker-3)
    Note over AG: host loses power at T
    GW-&gt;&gt;AG: request → TCP connect refused/timeout
    GW-&gt;&gt;GW: outlier detection ejects endpoints within ~2s, retry idempotent requests elsewhere
    Note over SCH: T+15s — 3 missed heartbeats
    SCH-&gt;&gt;PG: worker-7 status=unhealthy
    SCH-&gt;&gt;GW: remove worker-7 endpoints (generation++)
    Note over SCH: T+60s — still gone
    SCH-&gt;&gt;PG: worker-7 status=fenced, generation++ (rejects late reports)
    SCH-&gt;&gt;PG: mark its instances stopped (reason=worker_failure)
    loop for each affected release
        SCH-&gt;&gt;SCH: desired vs actual → deficit
        SCH-&gt;&gt;AG2: AssignInstance (placement avoids failed zone)
        AG2--&gt;&gt;SCH: READY
        SCH-&gt;&gt;GW: add endpoints
    end
    Note over SCH: releases with min_instances=0 and no traffic are NOT restarted
    Note over PG: usage records for worker-7 stop at last reported window,&lt;br/&gt;reconciliation caps billing at last heartbeat
    alt worker returns later
        AG-&gt;&gt;SCH: Register (generation mismatch)
        SCH--&gt;&gt;AG: full ReconcileSync with empty desired set
        AG-&gt;&gt;AG: stop all orphaned VMs, then rejoin as Ready
    end</pre></figure>

## 35.10 Deployment failure

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    participant SCH as Scheduler
    participant AG as Agent
    participant VM as microVM
    participant API as API
    participant GH as GitHub
    SCH-&gt;&gt;AG: AssignInstance(rel_new)
    AG-&gt;&gt;VM: boot
    VM-&gt;&gt;VM: app starts, binds 127.0.0.1:8080
    loop startup probe (60s deadline)
        AG-&gt;&gt;VM: TCP connect 172.16.0.2:8080 → refused
    end
    AG-&gt;&gt;AG: capture last 100 log lines + /proc/net/tcp listener snapshot
    AG-&gt;&gt;VM: kill
    AG-&gt;&gt;SCH: InstanceReport(START_FAILED, reason=probe_timeout, diagnostics)
    SCH-&gt;&gt;SCH: attempt 2 on a different worker → same failure
    SCH-&gt;&gt;SCH: attempt 3 → same failure
    SCH-&gt;&gt;API: deployment FAILED (max_start_failures)
    API-&gt;&gt;API: classify: listener on loopback → actionable message
    API-&gt;&gt;GH: check run FAILURE with the diagnostic
    API--&gt;&gt;Dev: notification
    Note over SCH: production alias NEVER moved — previous release still serving 100% of traffic
    Note over SCH: failed release&#x27;s instances all stopped, image retained for debugging</pre></figure>

## 35.11 WASM execution

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    autonumber
    actor C as Client
    participant EV as Envoy
    participant GW as Gateway
    participant WH as wasm-host (tenant process)
    participant ENG as Wasmtime Engine
    participant INST as Component instance
    participant EP as Egress proxy
    C-&gt;&gt;EV: GET https://fn.helix.app/hook
    EV-&gt;&gt;GW: forward
    GW-&gt;&gt;GW: route kind=wasm → pick a wasm-host for this tenant
    GW-&gt;&gt;WH: request (local socket / HTTP)
    WH-&gt;&gt;ENG: component from cache (mmap&#x27;d .cwasm, signature verified at load)
    ENG-&gt;&gt;ENG: pooling allocator: take a preallocated linear memory
    WH-&gt;&gt;INST: new Store(limits: 64MiB, epoch deadline 10s, WASI ctx)
    WH-&gt;&gt;INST: call wasi:http/incoming-handler.handle(request, response-out)
    opt outbound call
        INST-&gt;&gt;WH: wasi:http/outgoing-handler
        WH-&gt;&gt;WH: allowlist check (semantic egress control)
        WH-&gt;&gt;EP: HTTPS
        EP--&gt;&gt;INST: response
    end
    INST--&gt;&gt;WH: response stream
    WH--&gt;&gt;GW: response (streamed)
    GW--&gt;&gt;EV: 200
    WH-&gt;&gt;WH: drop Store → memory returned to pool (fresh instance next request)
    alt epoch deadline exceeded
        ENG--&gt;&gt;WH: trap: interrupted
        WH--&gt;&gt;GW: 504 x-helix-reason: execution_timeout
    else memory limit exceeded
        ENG--&gt;&gt;WH: trap: resource limit
        WH--&gt;&gt;GW: 500 x-helix-reason: memory_limit
    end
    Note over WH: per-tenant process — a Wasmtime escape is contained to one tenant</pre></figure>
