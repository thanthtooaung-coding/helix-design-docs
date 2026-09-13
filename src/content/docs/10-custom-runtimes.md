---
title: "10. Custom Runtimes"
description: "Dockerfiles, prebuilt images, external registries, base-image policy, scanning and signing."
sidebar:
  order: 10
---

## 10.1 The three entry points

| Mode | User provides | Platform does |
|---|---|---|
| Managed runtime | `helix.yaml` with `runtime.type` | Builds from a platform template |
| **Dockerfile** | `Dockerfile` + `helix.yaml` | Builds the Dockerfile in the sandbox |
| **Prebuilt image** | `image: registry/x@sha256:...` + credentials | Pulls, validates, re-hosts, runs |

Modes 2 and 3 are what make "any Linux application" true.

## 10.2 Dockerfile support

Supported: standard Dockerfile syntax via BuildKit, including multi-stage, `--mount=type=cache`, `--mount=type=secret`, `ARG`, `HEALTHCHECK` (mapped to `health` defaults), `EXPOSE` (hint for `http.port`), `USER`, `WORKDIR`, `ENTRYPOINT`/`CMD`, `ONBUILD` (discouraged).

Not supported / rewritten:
| Feature | Handling |
|---|---|
| `--privileged`, `--security-opt` build flags | Not exposed |
| `--network=host` | Not exposed |
| `VOLUME` | Ignored with a warning — the platform's filesystem is ephemeral ([§14](../14-storage-architecture/)) |
| `--mount=type=bind,from=<host path>` | Restricted to build context and named stages only |
| `--platform` mismatched with project architecture | Rejected with a clear error |
| Layers exceeding size limits | Rejected pre-push |

## 10.3 Image requirements

The platform must be able to run the image. Validation at release creation:

1. **Manifest/config sanity** — valid OCI or Docker v2.2 manifest, architecture matches the target, ≤ N layers (e.g. 127, the practical overlay limit), total uncompressed size ≤ plan limit.
2. **Entrypoint exists** — after flattening, the resolved command's binary is present and executable. Catch "typo'd path" at deploy time, not as a crashloop.
3. **Dynamic linking** — if the entrypoint is dynamically linked, its interpreter (`/lib64/ld-linux-x86-64.so.2` or musl equivalent) must be present. A shockingly common failure with `FROM scratch` and `FROM alpine` + glibc binaries; detect it and produce a real error message.
4. **No setuid surprises needed** — the platform strips file capabilities and setuid bits from the rootfs by default (with an opt-out), because they are useless in a single-user guest and are a privilege-escalation aid.
5. **Port reachability** — after boot, the startup probe must succeed. Guide users: bind `0.0.0.0:$PORT`, not `127.0.0.1`. This is the #1 support ticket in every platform of this kind; detect "listening on loopback only" from inside the guest via `vminit` reading `/proc/net/tcp` and emit a specific, actionable error.

## 10.4 External registry support

Users can deploy from Docker Hub, GHCR, ECR, GAR, or a private registry.

- Credentials stored as secrets, encrypted, scoped to the project, used only by the builder/importer.
- Platform **copies the image into the internal registry by digest** rather than pulling from the external registry at instance-start. Reasons: (a) availability — a Docker Hub outage should not stop your scale-ups, (b) rate limits — Docker Hub's pull limits will absolutely bite you, (c) immutability — an external tag can be re-pointed under you, (d) network policy — workers need no external registry egress at all.
- Mirroring happens once per digest, at deploy time, with the image re-signed by the platform.

## 10.5 Base image policy

Three policy modes, selectable per plan and per org:

| Mode | Behavior | For |
|---|---|---|
| `open` | Any base image; scan results advisory | Default self-serve |
| `curated` | Base image must be in the platform's verified set (distroless, alpine, debian-slim, ubuntu, language official images), pinned by digest, or derive from one | Enterprise/compliance |
| `signed-only` | Image must carry a valid signature from a key the org trusts | Enterprise |

Even in `open` mode, enforce hard rules: no images from hosts on a denylist, no images over the size limit, no images whose manifest declares `os != linux`, and always scan + SBOM.

## 10.6 Vulnerability scanning policy

- Scan every image with Trivy/Grype against OSV + distro advisories at build time and **re-scan periodically** (new CVEs appear for images you already shipped). Surface "your running production release has a new critical CVE" as a notification — this is genuinely valuable and differentiating.
- **Advisory by default.** A blocking policy on `CRITICAL` would block essentially every Debian-based image on day one and destroy the developer experience. Make blocking opt-in per org, with configurable severity and a "fixable only" filter (blocking on unfixable CVEs is pure friction).
- Cache scan results by image digest — rescanning the same digest is wasted money.

## 10.7 Image signing and admission

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    participant B as Builder agent
    participant K as KMS
    participant R as Registry
    participant A as Worker agent
    B-&gt;&gt;R: push image (digest D)
    B-&gt;&gt;K: sign(D) with platform key
    K--&gt;&gt;B: signature
    B-&gt;&gt;R: push cosign signature + SBOM + SLSA provenance attestations
    Note over A: later, at instance start
    A-&gt;&gt;R: fetch manifest + signature for D
    A-&gt;&gt;A: verify signature against pinned platform public key (offline)
    alt invalid or missing
        A--&gt;&gt;A: refuse to start, alert
    else valid
        A-&gt;&gt;A: build rootfs, boot VM
    end</pre></figure>

This closes the loop: even an attacker with registry write access cannot get code executed on the fleet without the signing key, which lives in KMS/HSM and is only usable by the builder service role.

## 10.8 Architecture compatibility

- Every release records `architecture`. The scheduler only places on matching workers.
- `architecture: auto` builds multi-arch when the runtime definition supports it, and the scheduler prefers arm64 (cheaper) with amd64 as fallback.
- Cross-arch builds: prefer **native builders** (an arm64 build worker pool) over QEMU emulation, which is 3–10× slower and has subtle bugs. Mixed-arch fleets are a V1+ cost optimization worth real money (roughly 20–40% on compute), but not an MVP concern.
