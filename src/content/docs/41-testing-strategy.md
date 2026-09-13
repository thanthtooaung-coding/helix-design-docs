---
title: "41. Testing Strategy"
description: "Test levels from unit to chaos, with the two suites that matter most and are easiest to skip."
sidebar:
  order: 41
---

| Level | Scope | Tooling | Gate |
|---|---|---|---|
| **Unit** | Pure logic: state machine transitions, placement scoring, config validation, quota math, retry/backoff | Go `testing`, Rust `cargo test` | Every PR; coverage floor on `internal/` packages |
| **Property-based** | Config schema round-trips, state-machine invariants (no unreachable state, no escape from terminal), scheduler never oversubscribes | `gopter`/`rapid`, `proptest` | Every PR |
| **Fuzzing** | vsock protocol parser, tar/rootfs extractor, OCI manifest parser, `helix.yaml` parser, LogQL builder | `go-fuzz`/native fuzzing, `cargo-fuzz`, OSS-Fuzz if open source | Continuous; any crash is a P1 |
| **Integration** | Control plane against real Postgres/Redis/NATS in containers; agent against real Firecracker on a KVM runner | `testcontainers`, a dedicated CI runner with `/dev/kvm` | Every PR (agent tests on the KVM runner) |
| **Contract** | OpenAPI spec ↔ server ↔ generated clients; protobuf compatibility (`buf breaking`) | `buf`, schemathesis | Every PR |
| **End-to-end** | Real deploy of real apps in 8+ languages: push → build → run → HTTP 200 → scale → rollback → delete | `test/e2e` against an ephemeral full stack | Every merge to main; nightly full matrix |
| **Security** | Automated escape attempts: reach 169.254.169.254, reach control plane, cross-tenant DB read (RLS), read another VM's rootfs, push outside namespace, setuid preserved, unsigned image start, snapshot entropy uniqueness | `test/security` | Every PR; **failures block release** |
| **Chaos** | Kill workers, agents, gateways, scheduler leader, Postgres primary, NATS node under load; network partition; disk fill; clock skew | Custom harness + `toxiproxy` / `pumba` | Weekly in staging; monthly in production |
| **Load** | 10× expected peak: request throughput, cold-start storms, 1000 simultaneous deploys, 10k instance churn | `k6`, `vegeta` | Before each major release |
| **Soak** | 72 hours at steady load, watching for leaks (fd, memory, cgroups, netns, snapshots, orphaned VMs) | | Before each major release |
| **Performance regression** | Cold start per runtime, VM boot time, build time, p99 platform latency, agent CPU per VM | Benchmarks with recorded baselines | Nightly; alert on >10% regression |
| **DR** | Backup restore verification, failover drills, region game day | | Daily / monthly / quarterly |
| **Upgrade** | Agent upgrade with running VMs; Firecracker upgrade; kernel upgrade; Wasmtime upgrade with `.cwasm` recompile; Postgres migration on a production-sized copy | | Every release |

**The two test suites that matter most and are easiest to skip:** `test/security` and the agent-upgrade test. The first is your license to operate; the second determines whether shipping an agent fix costs you an afternoon or a fleet-wide drain.
