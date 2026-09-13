---
title: "0. How to read this document"
description: "Conventions, maturity labels, an honest note on scope, and the glossary."
sidebar:
  order: 0
---

## 0.1 What this document is

This is the master technical design for a general-purpose Linux application deployment platform: developers push source code, the platform builds it, packages it as an OCI image, runs it inside a hardware-virtualized sandbox, exposes it over HTTPS, autoscales it including to zero, and meters it.

It is written to be implementable. Every major decision follows the same structure: **problem → candidate solutions → comparison → decision → why → tradeoffs → operational implications**. Where a decision is genuinely open, it is marked as such rather than resolved by fiat.

## 0.2 Maturity labels

Every component in this document carries a maturity label. This is the most important convention in the document, because the single biggest failure mode for a project of this scope is building the Future Scale version of everything on day one.

| Label | Meaning |
|---|---|
| <span class="mat mat-mvp">MVP</span> | Required to demonstrate the core loop end-to-end on one machine. If it is not needed to get `git push` → live URL working, it is not MVP. |
| <span class="mat mat-v1">V1</span> | Required before untrusted third-party code runs on shared infrastructure with paying customers. This is the real production bar. |
| <span class="mat mat-scale">SCALE</span> | Required only beyond roughly 10k tenants / multi-region. Design for it, do not build it. |

A design is only good if the MVP version is small. Throughout, the MVP version of each subsystem is called out explicitly, and it is usually much less impressive than the V1 version. That is deliberate.

## 0.3 A calibration note on scope

An honest statement before the technical content, because it changes how you should sequence the work:

The system described here is, at V1 completeness, roughly the scope of a 15–30 engineer product built over 2–4 years. Fly.io, Railway, Northflank, Koyeb and Vercel's own compute layer each represent that order of investment. Firecracker itself exists because AWS staffed a team against exactly this problem.

That is not an argument against building it. It is an argument for three things that shape the rest of this document:

1. **The phased roadmap in [§30](../30-implementation-roadmap/) is the real plan**; sections 1–29 are the target architecture that the roadmap converges on. Do not attempt sections 1–29 in order.
2. **The hard parts are not the parts that look hard.** Firecracker integration is a few thousand lines of Rust and is largely a solved, well-documented problem. The parts that will consume your calendar are: the build system's security boundary, the rootfs/image pipeline, the request-path activator for scale-to-zero, snapshot restore correctness, and the operational burden of running bare metal.
3. **Every feature you add multiplies the security surface**, because your entire product is "run arbitrary untrusted code." [§39](../39-production-security-review/) is a separate adversarial review written specifically to be read before you let a stranger deploy to your infrastructure.

## 0.4 Section map

| # | Section | Primary reader |
|---|---|---|
| 1 | Core abstraction and system overview | Everyone |
| 2 | Control plane | Backend |
| 3 | Compute plane | Systems |
| 4 | Deployment pipeline | Backend |
| 5 | Build system | Backend / Security |
| 6 | Runtime isolation and threat model | Security |
| 7 | Firecracker architecture | Systems |
| 8 | WASM architecture | Systems |
| 9 | Universal runtime specification | Backend / DX |
| 10 | Custom runtimes | Backend / Security |
| 11 | HTTP routing | Networking |
| 12 | Serverless scheduling | Distributed systems |
| 13 | Cold start optimization | Systems |
| 14 | Storage architecture | Backend |
| 15 | Database schema | Backend |
| 16 | API design | Backend / DX |
| 17 | Git integration and preview deployments | Backend / DX |
| 18 | Multi-tenancy | Everyone |
| 19 | Autoscaling | Distributed systems |
| 20 | High availability | SRE |
| 21 | Disaster recovery | SRE |
| 22 | Observability | SRE |
| 23 | Security architecture | Security |
| 24 | Abuse prevention | Security / Trust & Safety |
| 25 | Billing and metering | Backend / Finance |
| 26 | Developer experience and CLI | DX |
| 27 | Deployment configuration format | DX |
| 28 | Internal service inventory | Everyone |
| 29 | Repository structure | Everyone |
| 30 | Implementation roadmap | Everyone |
| 31 | Local development environment | Everyone |
| 32 | Production infrastructure sizing | SRE / Finance |
| 33 | Cost model | Finance |
| 34 | Technology decision matrices | Everyone |
| 35 | Sequence diagrams | Everyone |
| 36 | Architecture diagrams | Everyone |
| 37 | Failure scenarios | SRE |
| 38 | Distributed systems concerns | Distributed systems |
| 39 | Production security review | Security |
| 40 | Final recommended architecture | Everyone |
| 41 | Testing strategy | Everyone |
| 42 | Production readiness checklist | SRE |

## 0.5 Glossary

| Term | Meaning in this document |
|---|---|
| **Tenant** | An organization. The billing and isolation boundary. |
| **Project** | A deployable unit owned by a tenant, roughly one repository. |
| **Deployment** | One immutable attempt to build and run a specific commit with a specific config. |
| **Release** | A deployment that a routing alias currently points at. |
| **Instance** | One running microVM or one WASM instance serving a release. |
| **Worker** | A bare-metal (or metal-class) host that runs instances. |
| **Agent** | `helix-agent`, the Rust daemon on every worker. |
| **Router** | The request-path data plane: Envoy plus the activator. |
| **Activator** | The component that holds requests while a scaled-to-zero release is started. |
| **Artifact** | An OCI image (Linux path) or a precompiled `.cwasm` (WASM path). |
| **Rootfs** | An ext4 block image derived from an OCI image, attached to a microVM. |
