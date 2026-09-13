---
title: "39. Production Security Review"
description: "An adversarial review written before allowing arbitrary third-party code to run."
sidebar:
  order: 39
---

*This section is written adversarially, as an independent reviewer reading the preceding design before signing off on running arbitrary third-party code. It deliberately contradicts the optimism of earlier sections where warranted.*

## 39.1 Verdict

**The architecture is sound in its choice of primitives and would be a credible platform. It is not yet safe to run untrusted third-party code**, because several controls described above are described rather than specified, and a few assumptions are load-bearing but unvalidated. Below: critical findings first, then high, then dangerous assumptions.

## 39.2 Critical findings

**C-1 — The build plane is the weakest link and is described more confidently than it is specified.**
The design says builds run in Firecracker VMs <span class="mat mat-v1">V1</span> but permits rootless BuildKit in a container for MVP. In practice the MVP configuration will be running when the first external user arrives, because that is how schedules work. A container-isolated build executing arbitrary `RUN` commands with network access is a shared-kernel boundary — exactly the boundary the whole architecture exists to avoid.
*Mitigation:* make "builds run in microVMs" a **release gate**, not a phase goal. If the VM build is not ready, do not accept third-party signups. Additionally: no registry credential inside the build VM (already specified — verify it in a test), no host paths bind-mounted, and the egress proxy must be enforced by netns routing, not by configuration the build can override.

**C-2 — Snapshot entropy/clock handling is correct in the design and catastrophic if implemented late or partially.**
Restoring N VMs from one snapshot without reseeding produces identical CSPRNG state. Consequences: duplicate session tokens, duplicate UUIDs, predictable TLS randoms, and in some frameworks duplicate CSRF secrets — across *different customers' end users*. This is a data-breach-class bug that looks like a performance feature.
*Mitigation:* snapshots ship only with (a) VMGenID support verified in the guest kernel, (b) `vminit` post-restore reseed, (c) clock resync, (d) an automated test asserting 100 restored VMs produce 100 distinct random values, run in CI on every kernel/Firecracker/vminit change. Treat a failure of that test as a P0.

**C-3 — No specified defense against a malicious OCI image attacking the rootfs conversion path.**
The agent untars attacker-controlled layers on the *host*. Path traversal (`../`), symlink escapes, device nodes, setuid binaries, xattrs with capabilities, hardlinks to host files, and decompression bombs are all attacker-controlled. A bug here is a host compromise with no VM boundary in the way, because the conversion happens before any VM exists.
*Mitigation:* perform extraction in a dedicated, unprivileged, namespaced helper process (or in a VM); use a hardened tar implementation that rejects absolute paths, `..`, symlinks pointing outside the root, and device nodes; strip setuid/setgid and file capabilities and all xattrs by default; enforce a hard uncompressed-size and inode limit; fuzz the extractor. This should be an explicit component with its own threat model, not a helper function.

**C-4 — The `vsock` interface is a direct guest→privileged-host channel and is under-specified.**
The agent parses framed data from a fully untrusted guest, in the privileged process. Rust removes memory-safety bugs but not logic bugs, resource exhaustion, or protocol confusion.
*Mitigation:* the vsock protocol must be length-prefixed with hard caps, non-blocking, per-VM rate-limited and memory-bounded; the parser must be fuzzed continuously; and ideally the guest-facing parsing should happen in an unprivileged per-VM helper process that relays only validated messages to the agent. Downgrading "logs" from a parsed protocol to opaque bounded byte chunks removes most of the risk.

**C-5 — Cloud metadata / SSRF protection is stated for guests and builds but not for the control plane.**
The control plane fetches user-supplied URLs: outbound webhooks, custom git remotes, external registry endpoints, ACME callbacks. Without DNS-rebinding-resistant validation, a customer can make the control plane — which *does* hold credentials — issue requests to internal services.
*Mitigation:* a single egress client used for all user-supplied URLs: resolve, validate every resolved IP against a denylist (RFC1918, loopback, link-local, CGNAT, IPv6 ULA/mapped), **connect to the validated IP directly** (pin the resolution), re-validate on every redirect, cap redirects, cap response size, and enforce timeouts. Route it through a separate egress proxy with no credentials.

## 39.3 High-risk findings

**H-1 — Firecracker/KVM 0-day has no compensating control beyond blast radius.**
Accepted risk, but make it explicit and monitored: host-level behavioral detection ([§24.4](../24-abuse-prevention/#244-detecting-a-compromised-platform-host)), automatic host isolation on anomaly, rapid patch capability (can you patch and roll the entire fleet in under 24 hours? test it), and a documented incident response that assumes a host is compromised.

**H-2 — Worker mTLS certificate theft after a VM escape.**
A guest that escapes to the host can read the agent's client certificate and impersonate the worker. The design says the control plane authorizes per-node, which limits it, but an attacker-controlled "worker" could report false capacity, accept assignments for other tenants' releases, and thereby receive **other tenants' decrypted secrets**.
*Mitigation:* this is the sharpest consequence of an escape. Bind worker identity to hardware where possible (TPM-backed keys); keep certificate lifetime very short; require the control plane to only send secrets for instances it *placed* on that node in the current epoch; add anomaly detection on a worker whose reported capacity or assignment pattern changes abruptly. Consider per-instance secret delivery tokens that the agent cannot replay for other instances.

**H-3 — Multi-tenant CPU side channels are mitigated by policy that is easy to regress.**
Core scheduling must be verified continuously, not configured once. A kernel upgrade, a cgroup refactor, or a "performance improvement" can silently disable it.
*Mitigation:* an automated test on every worker that asserts core-scheduling cookies are applied and that SMT siblings never run different orgs. Export it as a metric and alert on violations.

**H-4 — Envoy xDS is a single point of total routing failure.**
A malformed snapshot pushed to all Envoys can break every route at once. This is a self-inflicted global outage with a very short path from a code bug.
*Mitigation:* validate snapshots against a schema and a set of invariants before publishing; canary to one Envoy and verify synthetic traffic before fleet-wide rollout; keep last-known-good and roll back automatically on health regression; rate-limit snapshot publication.

**H-5 — Secret material in snapshots is acknowledged but the lifecycle is not.**
Snapshots contain environment secrets in memory. If a secret is rotated because it leaked, every snapshot containing it must be destroyed, everywhere, including object storage replicas and worker caches.
*Mitigation:* index snapshots by the secret-set version; rotation triggers immediate invalidation and deletion, with a verification job. Encrypt snapshots with a key derived per secret-version so that destroying the key crypto-erases them.

**H-6 — Log pipeline as a cross-tenant risk.**
Customer log content is attacker-controlled and flows through shared infrastructure into a shared query interface. Risks: log injection producing forged entries, LogQL injection if queries are built from user input, ANSI/terminal escape sequences in the CLI and dashboard, and resource exhaustion from a single high-volume tenant.
*Mitigation:* treat log lines as opaque bytes end to end; escape on render in both CLI and web; never build LogQL from client strings; per-tenant ingestion quotas with visible drops.

**H-7 — Abuse response is described but unstaffed.**
Every control in [§24](../24-abuse-prevention/) assumes a human review queue with an SLA. Without staffing, the graduated response collapses to either "auto-terminate" (false positives destroy legitimate customers) or "do nothing" (your IP ranges get blocklisted and your upstream provider terminates you).
*Mitigation:* before opening self-serve signup, define who is on the abuse rotation, what the SLA is, and what the automated actions are when nobody responds. A free tier without this is a liability.

**H-8 — Public Suffix List registration is a prerequisite, not a nicety.**
If `helix.app` is not on the PSL, customer apps on `*.helix.app` can set cookies scoped to the parent domain and attack each other and potentially the dashboard.
*Mitigation:* submit to the PSL early (it takes weeks to propagate into browsers), serve customer content from a domain that is *not* the dashboard's registrable domain, and set `__Host-` prefixed cookies everywhere.

## 39.4 Missing controls

| Gap | Recommendation |
|---|---|
| No specified WAF or bot management at the edge | Add at least basic protection; customers will expect it and it reduces your own abuse surface |
| No per-instance egress DNS logging retention policy | Needed for abuse forensics; define retention and access |
| No specified process for emergency global kill-switch | You need "stop all instances for org X" and "stop all new starts platform-wide" as tested operations |
| No dependency on a hardware root of trust for workers | Secure boot + measured boot + TPM-bound identity closes H-2 substantially |
| No specified handling of `CAP_*` / setuid in customer images | Specified to be stripped — make it a verified test, not a documented intention |
| No rate limit on snapshot creation | A tenant cycling deployments could fill worker disks with snapshots |
| No specified review process for runtime definitions | They execute as root in build VMs and define what runs. Treat as code: two-person review, signed, digest-pinned |
| Incident response plan not written | Write it before launch: severity levels, comms templates, evidence preservation, customer notification obligations |

## 39.5 Dangerous assumptions

1. **"Firecracker makes untrusted code safe."** It makes it *safer*. Half of your real risk is network, supply chain, and abuse. The document says this; make sure the team believes it.
2. **"Rust prevents agent vulnerabilities."** It prevents memory corruption. It does not prevent TOCTOU on filesystem paths, symlink races in the jail setup, logic errors in seccomp filter construction, or resource exhaustion.
3. **"The control plane is trusted."** It is internet-facing and processes untrusted input (config, webhooks, URLs, image manifests). It deserves the same scrutiny as the data plane.
4. **"We'll add the security controls in Phase 2."** Phase boundaries slip; user signups do not wait. Tie *signup availability* to specific controls, not to phase numbers.
5. **"Scan results are advisory, so scanning is low-stakes."** The scanner itself parses attacker-controlled archives. Run it sandboxed.
6. **"Our egress IPs are fine."** They will be blocklisted within weeks of opening a free tier. Plan IP hygiene before launch, not after.

## 39.6 Recommended gates before untrusted signup

A concrete, checkable list:

- [ ] Builds execute in Firecracker microVMs; no registry credential reachable from build code (verified by test).
- [ ] Rootfs extraction runs unprivileged and sandboxed; hardened extractor fuzzed; setuid/caps/xattrs stripped (verified by test).
- [ ] vsock protocol bounded, rate-limited, fuzzed; log path handles opaque bytes only.
- [ ] nftables policy verified by automated test: metadata, RFC1918, platform subnets, SMTP unreachable from a guest and from a build.
- [ ] Control-plane SSRF guard implemented for every user-supplied URL, with DNS pinning and redirect re-validation.
- [ ] Snapshot entropy/clock test passing in CI (100 VMs → 100 distinct secrets).
- [ ] Core scheduling verified continuously; SMT policy enforced.
- [ ] Image signature verification enforced at the agent; unsigned images refuse to start.
- [ ] RLS enabled and tested on every tenant table; cross-tenant read test in CI.
- [ ] `helix.app` (or equivalent) submitted to the Public Suffix List; customer content on a separate registrable domain.
- [ ] Abuse rotation staffed with a documented SLA; `abuse@` monitored; kill-switch tested.
- [ ] External penetration test completed with critical findings closed.
- [ ] Incident response plan written and one tabletop exercise completed.
- [ ] Fleet-wide emergency patch rehearsed end to end in under 24 hours.
