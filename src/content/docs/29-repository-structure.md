---
title: "29. Repository Structure"
description: "A production monorepo layout, with the additions that are easy to forget in planning."
sidebar:
  order: 29
---

```text
helix/
├── README.md
├── Makefile                         # dev, test, lint, build, e2e — one entry point
├── docker-compose.dev.yaml          # postgres, redis, nats, registry, minio, loki, grafana
├── go.work                          # Go workspace for the Go modules
├── Cargo.toml                       # Rust workspace
│
├── api/
│   ├── openapi/helix-v1.yaml        # SOURCE OF TRUTH for the public API
│   └── proto/                       # internal gRPC
│       ├── worker/v1/worker.proto
│       ├── scheduler/v1/scheduler.proto
│       └── logs/v1/logs.proto
│
├── control-plane/                   # Go — the modular monolith
│   ├── cmd/helix-control/main.go
│   ├── internal/{auth,project,deploy,domain,secret,schedule,usage,notify}/
│   ├── internal/platform/{db,nats,kms,authz,telemetry,outbox,idempotency}/
│   ├── migrations/                  # goose/atlas SQL migrations, forward-only
│   └── testdata/
│
├── gateway/                         # Go — activator + proxy + route cache
│   ├── cmd/helix-gateway/
│   └── internal/{router,activator,cache,proxy}/
│
├── builder/                         # Go — build coordinator
│   ├── cmd/helix-builder/
│   └── internal/{queue,vm,buildkit,artifact,scan,sign,egressproxy}/
│
├── agent/                           # Rust — worker agent
│   ├── src/{main.rs,control.rs,firecracker/,wasm/,image/,network/,resource/,logs/,metrics/,health/,store.rs}
│   └── tests/
│
├── vminit/                          # Rust — guest PID 1
│   └── src/main.rs
│
├── wasm-host/                       # Rust — Wasmtime embedder
│   └── src/
│
├── shared/
│   ├── config-schema/               # Rust + Go bindings for helix.yaml validation
│   │   ├── schema.json
│   │   └── ...                      # ONE schema, both languages generate from it
│   └── protoutil/
│
├── cli/                             # Go
│   └── cmd/helix/, internal/...
│
├── sdk/
│   ├── typescript/
│   ├── go/
│   └── python/
│
├── dashboard/                       # Next.js
│
├── runtime-definitions/             # DATA, not code — the extensibility surface
│   ├── schema.json
│   ├── java/{17.yaml,21.yaml}
│   ├── node/{20.yaml,22.yaml}
│   ├── python/{3.11.yaml,3.12.yaml}
│   ├── go/1.23.yaml
│   ├── rust/1.81.yaml
│   ├── php/8.3.yaml
│   ├── ruby/3.3.yaml
│   ├── dotnet/8.yaml
│   ├── elixir/1.17.yaml
│   ├── wasm/component-0.2.yaml
│   └── README.md                    # "how to add a language" — a 30-minute task
│
├── images/                          # Dockerfiles for platform-provided images
│   ├── build/{java,node,python,...}/Dockerfile
│   ├── run/{java,node,python,...}/Dockerfile
│   └── buildkit-vm/                 # the build VM rootfs
│
├── kernel/                          # guest kernel build
│   ├── config-amd64
│   ├── config-arm64
│   └── build.sh
│
├── infrastructure/
│   ├── terraform/{modules,envs/{dev,staging,prod}}/
│   ├── ansible/                     # worker host provisioning, hardening
│   ├── packer/                      # worker base image
│   └── k8s/                         # control plane manifests (if you run CP on k8s)
│
├── deploy/
│   ├── helm/                        # control plane chart
│   └── systemd/                     # agent, gateway unit files
│
├── test/
│   ├── e2e/                         # full deploy-to-URL tests against a live stack
│   ├── load/                        # k6 / vegeta scenarios
│   ├── chaos/                       # fault injection scenarios
│   └── security/                    # sandbox escape attempts, RLS assertions
│
├── tools/
│   ├── rootfs-builder/              # OCI → ext4 (also usable standalone for debugging)
│   ├── devstack/                    # spin up the whole platform locally
│   └── loadgen/
│
└── docs/
    ├── architecture/                # THIS document, split by section
    ├── adr/                         # architecture decision records — 0001-oci-as-artifact.md, ...
    ├── runbooks/                    # one per alert
    ├── security/                    # threat model, review notes, incident response
    └── user/                        # customer-facing docs source
```

**Improvements over the sketch in the brief:**

- `scheduler/` is **not** a top-level directory — it is a module inside `control-plane/`. Giving it a top-level folder invites premature extraction.
- Added `vminit/` and `wasm-host/` — both are real deliverables that are easy to forget in planning.
- Added `shared/config-schema/` with **one** schema generating both Go and Rust validation. This prevents the CLI/server validation drift problem.
- Added `kernel/` and `images/` — the guest kernel and the build/run images are products you version and ship, not incidental files.
- Added `runtime-definitions/` with its own README framed as "adding a language takes 30 minutes." Make this contribution-friendly; it is where community help is actually useful.
- Added `docs/adr/` — you will re-litigate these decisions in 18 months and want the reasoning.
- Added `test/security/` — sandbox escape attempts as *automated tests* (attempt to reach the metadata service, attempt cross-tenant DB reads, attempt to read another VM's memory). Run in CI.

**Monorepo, yes.** Cross-cutting changes (a protobuf field, the config schema, a new runtime) touch 4+ components; atomic commits and one CI pipeline are worth far more than independent versioning at this team size.
