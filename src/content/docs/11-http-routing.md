---
title: "11. HTTP Routing"
description: "Envoy at the edge, the activator, TLS and domains, protocols, timeouts and load balancing."
sidebar:
  order: 11
---

## 11.1 The request path

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    C[Client] --&gt; DNS[&quot;DNS: *.helix.app → anycast / GeoDNS&quot;]
    DNS --&gt; LB[&quot;L4: BGP anycast + ECMP, or cloud NLB&quot;]
    LB --&gt; ENV[&quot;Envoy edge (per PoP/region)&lt;br/&gt;TLS 1.2/1.3, HTTP/1.1, H2, H3&lt;br/&gt;SNI → cert, rate limit, WAF, body limits&quot;]
    ENV --&gt; RT{Route lookup&lt;br/&gt;host + path → release}
    RT --&gt;|warm instance exists| DIRECT[Direct to worker instance endpoint]
    RT --&gt;|no ready instance| ACTV[&quot;Activator: hold request,&lt;br/&gt;request activation, wait&quot;]
    ACTV --&gt;|instance ready| DIRECT
    ACTV --&gt;|budget exceeded| E503[&quot;503 with Retry-After&quot;]
    DIRECT --&gt; WK[&quot;Worker host: DNAT&quot;]
    WK --&gt; VM[&quot;microVM 172.16.0.2:PORT&quot;]
    VM --&gt; APP[&quot;Application&quot;]
    RT --&gt;|kind=wasm| WH3[&quot;wasm host: instantiate + invoke&quot;]</pre></figure>

## 11.2 Proxy selection

**Problem.** The edge proxy must: terminate TLS for tens of thousands of custom domains with dynamic certs; route on `Host` + path to a set of dynamically-changing upstream endpoints (instances appear and disappear every second); support H2 and ideally H3; support WebSockets and streaming; emit good telemetry; and be reconfigurable thousands of times per minute **without dropping connections**.

**Candidates.**

| Criterion | Envoy | HAProxy | Nginx (OSS) |
|---|---|---|---|
| Dynamic config without reload | **xDS: native, incremental (delta xDS), designed for exactly this** | Runtime API + `server-template` slots: good for servers, awkward for adding *new backends/frontends*; cert updates possible via runtime API | Reload-based (`nginx -s reload`) — spawns new workers, drains old. Works, but at thousands of reloads/hour it is memory-churny and error-prone. OSS lacks dynamic upstream APIs (that is NGINX Plus) |
| TLS SNI with 50k+ certs | Good; SDS for dynamic certs, supports lazy cert loading | Good, `crt-list` + runtime API | Requires files + reload, or Lua/njs hacks |
| HTTP/3 | Yes (QUIC) | Yes (recent versions) | Yes (recent) |
| gRPC / H2 upstream | Excellent | Good | Adequate |
| WebSockets / streaming | Yes | Yes | Yes |
| Observability | Best-in-class stats, access log formats, OpenTelemetry native | Good | Basic |
| Extensibility in the request path | ext_authz, ext_proc, Lua, **Wasm filters** | Lua, SPOE | njs, Lua (3rd party) |
| Raw throughput / latency | Good; higher memory and CPU per connection than HAProxy | **Best** | Very good |
| Memory footprint | Highest (~100s MB with large configs) | Lowest | Low |
| Operational complexity | **Highest** — xDS control plane is a system you must build and operate | Low | Lowest |
| Config debuggability | Hard (generated protobuf) | Easy | Easiest |

**Decision: Envoy at the edge, with a Go xDS control plane, plus a separate `helix-gateway` activator. [MVP → V1]**

Why: the defining requirement is **high-frequency dynamic reconfiguration of routes, clusters, endpoints and certificates**. That is precisely what xDS was built for, and every alternative requires you to invent a worse version of it. The Wasm/ext_proc extension points also give you a place to run per-tenant edge middleware later without forking a proxy.

**Tradeoffs, stated honestly:**
- You must build and operate an xDS server. `go-control-plane` makes this tractable but it is real work and a real source of outages (a bad snapshot can break all routing at once — mitigate with snapshot validation, canary Envoys, and a "last known good" fallback).
- Envoy's memory footprint with 50k routes and 50k certs is substantial. Mitigations: on-demand/delta xDS (VHDS for virtual hosts, on-demand CDS), and lazy SDS so certs load on first SNI hit rather than all at boot.
- Envoy is harder to debug at 3 a.m. than an nginx config file. Invest in `/config_dump` tooling and good dashboards early.

**Why not HAProxy:** it is the fastest and leanest, and for a *static* set of backends it would win. But `server-template` requires pre-allocating slots for maximum backend count, and adding new frontends/backends still needs a reload. For a platform where "backend set" changes continuously, this becomes a constant fight.

**Why not Nginx OSS:** reload-driven configuration at this change rate is the wrong model, and the dynamic features you would need are in the commercial product.

**Alternative worth revisiting at <span class="mat mat-scale">SCALE</span>:** write the edge in Rust on **Pingora** (or `hyper` + `rustls`). Cloudflare's rationale — lower memory per connection, better connection reuse, full control — applies directly at very large scale. Do not do this before you have a working product; it is a 6–12 month project that adds no user-visible value on day one.

## 11.3 Route table and propagation

The route table is small and simple by design:

```text
(host, path_prefix) → route {
    release_id, kind, weight, timeouts, body limits,
    endpoints: [ {worker_ip, port, zone, capacity_hint} ],
    scale_to_zero: bool, cold_start_budget
}
```

Propagation, two tiers:

1. **Envoy xDS** — hosts, TLS certs, and the *coarse* cluster (pointing at the `helix-gateway` pool for scale-to-zero apps, or directly at an EDS cluster of instance endpoints for always-on apps). Updated on release changes: order of hundreds per minute. Fine for xDS.
2. **Gateway route cache** — the fine-grained, rapidly-changing part (which instances are ready *right now*) lives in the gateway process, fed by (a) a Redis-backed snapshot with a generation counter and (b) a gRPC stream from the control plane. Instance churn is thousands per minute; pushing that through xDS would be wasteful.

This two-tier split is the key design choice: **Envoy handles the slow-changing parts (TLS, hostnames); the gateway handles the fast-changing parts (live endpoints, activation).**

Generations are monotonic per route; the gateway ignores any update with a generation ≤ what it already has. If the control plane is unreachable, the gateway keeps serving the last-known table indefinitely, marking it stale in metrics.

## 11.4 The activator (scale-to-zero request path)

This component is what makes serverless feel instant-ish, and it does not exist in off-the-shelf proxies.

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    participant E as Envoy
    participant G as helix-gateway (activator)
    participant R as Redis
    participant S as Scheduler
    participant A as Worker agent
    participant V as microVM
    E-&gt;&gt;G: request for release X
    G-&gt;&gt;G: lookup ready endpoints → none
    G-&gt;&gt;R: SETNX activating:X (single-flight, TTL 30s)
    alt this request won the race
        G-&gt;&gt;S: Activate(release X, reason=request)
        S-&gt;&gt;S: pick worker (warm pool? snapshot? cold?)
        S-&gt;&gt;A: AssignInstance
        A-&gt;&gt;V: restore snapshot / boot VM
        V--&gt;&gt;A: startup probe OK
        A--&gt;&gt;S: InstanceReport READY
        S--&gt;&gt;G: endpoint available (push)
    else another request is already activating
        G-&gt;&gt;G: join the waiting queue for X
    end
    G-&gt;&gt;G: hold request up to cold_start_budget
    alt ready in time
        G-&gt;&gt;V: proxy request
        V--&gt;&gt;G: response
        G--&gt;&gt;E: response
    else timeout
        G--&gt;&gt;E: 503 + Retry-After, with an explanatory header
    end</pre></figure>

Design requirements:
- **Single-flight per release.** 500 concurrent requests to a cold app must cause one cold start, not 500. Redis `SETNX` plus in-process coalescing.
- **Bounded queue.** Per-release queue cap (e.g. `target_concurrency × max_instances`); beyond that, shed with 503 immediately rather than building an unbounded backlog.
- **Request buffering.** The activator must buffer the request body up to `max_request_body` to be able to replay it to the instance. Above that limit, stream — which means you cannot retry, so document it.
- **Progressive scale-up.** While holding N queued requests, tell the scheduler `N / target_concurrency` instances are needed, not one.
- **Hand-off.** Once instances exist, the gateway proxies directly; for always-on releases Envoy can bypass the gateway entirely and go straight to instance endpoints (one less hop for the hot path).
- **Fairness.** One tenant's cold-start storm must not exhaust gateway memory. Per-tenant queue and memory budgets.

## 11.5 TLS, domains and certificates

| Concern | Design |
|---|---|
| Platform wildcard (`*.helix.app`, `*.preview.helix.app`) | One wildcard cert per zone via ACME DNS-01, auto-renewed, distributed via SDS. Note: `*.helix.app` does **not** cover `a.b.helix.app` — use a dedicated label scheme (`<slug>-<hash>.helix.app`) so one wildcard suffices |
| Custom domains | User adds `api.customer.com`; platform verifies ownership via a `TXT` record or by observing the CNAME/A pointing at the platform; then issues a cert via ACME HTTP-01 (once traffic routes) or DNS-01 (if the user delegates) |
| Apex domains | Provide an anycast A/AAAA target, or ALIAS/ANAME guidance per DNS provider |
| Cert storage | Encrypted in Postgres (private keys via envelope encryption), distributed to Envoy via SDS over mTLS. Never on Envoy's local disk unencrypted |
| Renewal | Renew at 2/3 of lifetime; alert on failures ≥ 14 days before expiry; a cert-expiry outage is one of the most common platform incidents — monitor it as a P1 SLO |
| ACME rate limits | Let's Encrypt limits (50 certs/registered-domain/week, 300 new orders/3h) will bite. Mitigations: use the wildcard for platform domains; batch SANs where appropriate; consider a second CA (ZeroSSL/Google Trust) as failover; implement your own order queue with backoff |
| OCSP / revocation | OCSP stapling enabled; must-staple optional |
| TLS versions | 1.2 and 1.3 only; modern cipher suites; HSTS optional per domain (with a clear warning — HSTS is hard to undo) |
| mTLS for customers | <span class="mat mat-scale">SCALE</span> per-domain client cert requirements |

## 11.6 Protocol support

| Feature | Client ↔ Envoy | Envoy ↔ gateway/instance | Notes |
|---|---|---|---|
| HTTP/1.1 | ✅ | ✅ | Default to instances |
| HTTP/2 | ✅ | ✅ (h2c if app supports) | `http.protocol: http2` in config |
| HTTP/3 (QUIC) | ✅ <span class="mat mat-v1">V1</span> | ❌ (unnecessary internally) | Advertise via `Alt-Svc`; requires UDP/443 at the LB and careful anycast handling |
| WebSockets | ✅ | ✅ (upgrade passthrough) | Must be opted into (`http.websockets: true`) because it breaks scale-to-zero assumptions: a WS connection pins an instance. Bill accordingly and exclude from concurrency-based scale-down |
| SSE / streaming responses | ✅ | ✅ | Disable response buffering for these routes; ensure `max_response_body` does not truncate |
| gRPC | ✅ | ✅ | Works as H2; trailers must pass through |
| Request/response compression | Envoy brotli/gzip filter | — | Do it at the edge, not in every customer app |

## 11.7 Timeouts, limits and their interaction

Get these consistent or you will produce mysterious 502s.

| Parameter | Default | Notes |
|---|---|---|
| Client idle timeout (Envoy) | 300 s | |
| Request header timeout | 10 s | Slowloris defense |
| **Request timeout (end-to-end)** | 30 s (max 900 s with streaming) | Must be > cold start budget + app processing |
| Cold start budget | 5 s (configurable to 60 s) | The activator's hold time |
| Upstream connect timeout | 2 s | To a known-ready instance |
| Upstream idle timeout | 60 s | Must be **shorter** than the app's keep-alive timeout, otherwise you race the server closing a connection and get spurious 502s. Document this; it is the single most common keep-alive bug |
| Max request body | 10 MiB (to 100 MiB) | Enforced at Envoy; larger uploads should go direct to object storage with presigned URLs |
| Max response body | Unlimited when streaming; else 100 MiB | |
| Max concurrent streams (H2) | 100 | |
| Connections per client IP | rate-limited | |
| Drain timeout | 90 s | Must be ≥ request timeout for clean deploys |

## 11.8 Load balancing and health

- **Algorithm:** least-request (P2C) across ready instances. Round-robin is wrong for serverless because request durations vary wildly; least-request naturally routes around a slow instance.
- **Locality:** prefer instances in the same zone as the gateway, spill to other zones when local capacity is saturated (Envoy locality-weighted LB, or gateway-side logic).
- **Outlier detection:** eject an instance after N consecutive 5xx or high latency; re-admit after a backoff. This automatically routes around a broken instance before health checks notice.
- **Health signals, three sources:** (a) agent-driven readiness probe → authoritative, propagated via control plane; (b) gateway-observed errors → outlier ejection, fast and local; (c) connection failures → immediate removal + retry on another instance.
- **Retries:** safe methods and idempotent requests only (`GET/HEAD/OPTIONS`, or any request with an `Idempotency-Key`), max 1 retry, only on connect-failure/refused-stream/503 with no bytes sent. Retrying non-idempotent POSTs will corrupt customer data — do not.

## 11.9 What happens when the control plane is down

The single most important routing property:

| Situation | Behavior |
|---|---|
| Control plane unreachable, instances healthy | **Traffic flows normally.** Envoy uses last xDS snapshot; gateway uses last route table |
| Control plane unreachable, an instance dies | Gateway removes it via connection failure + outlier detection; remaining instances serve. No replacement is started (that needs the scheduler) |
| Control plane unreachable, app is scaled to zero | **Cold start fails** → 503. This is the honest limitation. Mitigation: keep `min_instances ≥ 1` for anything critical, and make that recommendation explicit in the product |
| Redis down | Gateway falls back to in-memory cache + gRPC; single-flight degrades to per-gateway-replica (a few duplicate cold starts, acceptable) |
| A gateway replica dies | Its in-flight requests fail; L4 LB routes elsewhere; clients retry |
