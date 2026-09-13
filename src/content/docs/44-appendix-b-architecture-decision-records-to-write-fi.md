---
title: "44. Appendix B — Architecture decision records to write first"
description: "The architecture decision records to write first."
sidebar:
  order: 44
---

| ADR | Decision |
|---|---|
| 0001 | OCI image as the universal artifact |
| 0002 | Firecracker as the primary isolation boundary |
| 0003 | Go control plane as a modular monolith; Rust for the privileged agent |
| 0004 | PostgreSQL as the sole source of truth; transactional outbox for side effects |
| 0005 | Envoy + custom activator for the edge; two-tier route propagation |
| 0006 | Concurrency (not CPU) as the primary autoscaling signal |
| 0007 | WASM as a separate deployment type, never an automatic optimization |
| 0008 | Builds execute in microVMs; no credentials inside the build sandbox |
| 0009 | Bare metal as the default infrastructure; cloud for stateful services and burst |
| 0010 | Ephemeral-only application filesystem |
