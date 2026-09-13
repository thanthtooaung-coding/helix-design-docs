---
title: "23. Security Architecture"
description: "Authentication, authorization, secrets, encryption, key management, supply chain and the attack tree."
sidebar:
  order: 23
---

## 23.1 Authentication

| Surface | Mechanism | Controls |
|---|---|---|
| Dashboard | Email+password (Argon2id) or OIDC/SAML; TOTP/WebAuthn MFA | Session cookie `__Host-` prefixed, `Secure; HttpOnly; SameSite=Lax`, 7-day sliding with 30-day absolute; CSRF token on mutations; session invalidation on password change; device list with revocation |
| CLI / API | PATs `hxp_<prefix>_<secret>` | `sha256` storage, scopes, expiry, last-used tracking, GitHub secret-scanning partnership, one-time display |
| CI | Machine tokens, optionally OIDC federation (GitHub Actions → short-lived token, no stored secret) | OIDC federation is the right answer and eliminates long-lived CI secrets |
| Workers | mTLS with SPIFFE-style SVIDs, 24 h rotation | Node identity established at provisioning via a one-time bootstrap token |
| Internal services | mTLS, SPIFFE IDs, per-method authorization | |
| Git providers | GitHub App JWT → per-installation short-lived tokens | |

Brute-force defense: per-account and per-IP exponential backoff, account lockout with self-service recovery, CAPTCHA after N failures, and credential-stuffing detection (many accounts, one IP, high failure rate).

## 23.2 Authorization

Covered in [§16.3](../16-api-design/#163-authorization). Additional platform-level controls:
- **Deny by default.** The authorization function returns `denied` unless a rule explicitly permits.
- **A single choke point.** All handlers call `authz.Check(ctx, action, resource)`. A linter/test asserts that every mutating handler does.
- **Every denial is audit-logged** with actor, resource, and action. A spike in denials is an attack signal.
- **Cross-tenant access is impossible by construction**, not by check: the repository layer requires a `TenantContext`, and RLS is the backstop.

## 23.3 API security

- TLS 1.2+ only; HSTS on the API domain.
- Strict body size limits, JSON depth/size limits, request timeout.
- CORS: dashboard origin only; the API is not designed for direct browser use from customer sites.
- No sensitive data in URLs (they land in logs and referrers).
- Security headers on the dashboard: CSP with nonces, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY`.
- **Customer-content isolation:** customer apps are served on `*.helix.app`, which is a *different registrable domain* from the dashboard. Put `helix.app` on the Public Suffix List, otherwise a customer's app can set cookies for `helix.app` and attack the dashboard, and `document.domain`/cookie-scope attacks become possible. This is a common and serious oversight.

## 23.4 Secrets management

<figure class="mermaid-figure"><pre class="mermaid">graph LR
    subgraph KMSB[&quot;KMS / HSM&quot;]
        CMK[&quot;Customer Master Key per org (or per environment)&quot;]
    end
    subgraph PGB2[&quot;PostgreSQL&quot;]
        DEK[&quot;data_keys: wrapped DEK&quot;]
        CT[&quot;secrets: AES-256-GCM ciphertext + nonce&quot;]
    end
    subgraph CPB[&quot;helix-control (memory only)&quot;]
        UNW[&quot;Unwrapped DEK, TTL-cached&quot;]
        PT[&quot;Plaintext secret, request-scoped&quot;]
    end
    subgraph AGB[&quot;Worker&quot;]
        ENVV[&quot;Env vars in Firecracker config → vsock → guest memory&quot;]
    end
    CMK --&gt;|Decrypt| UNW
    DEK --&gt; UNW
    CT --&gt; PT
    UNW --&gt; PT
    PT --&gt;|mTLS gRPC| ENVV</pre></figure>

Rules:
- Envelope encryption: per-org DEK wrapped by a KMS CMK; DEK rotated quarterly; secrets re-encrypted lazily.
- Plaintext exists only in `helix-control` memory (request-scoped, zeroed after use where the language permits) and in guest memory.
- **Never written to worker disk.** Secrets go into the Firecracker config that lives in a tmpfs inside the jail, or better, are delivered to `vminit` over vsock after boot so they never touch a file at all. Prefer the vsock path.
- Never on the kernel command line (world-readable via `/proc/cmdline`).
- Never in logs: structured logging with a redaction middleware plus a test that asserts known secret values never appear in log output.
- Never returned by the API after creation.
- Rotation: `PATCH` creates a new version; old versions retained briefly for rollback, then destroyed.
- **Snapshots contain secrets in guest memory** — encrypt snapshot files at rest, scope them per org, and invalidate on secret rotation ([§7.11](../07-firecracker-architecture/#711-snapshot-correctness-hazards--read-this-before-shipping-snapshots)).

## 23.5 Encryption

| Data | At rest | In transit |
|---|---|---|
| Postgres | Full-disk (LUKS) + column-level for secrets/keys | TLS between app and DB, and for replication |
| Object storage | SSE with KMS keys (or client-side for the most sensitive buckets) | TLS |
| Registry blobs | Storage-layer encryption | TLS (mTLS internally) |
| Snapshots | AES-256-GCM with per-org key | TLS |
| Worker local disk (rootfs cache, overlays) | **LUKS full-disk encryption on worker NVMe** — protects against physical disk recovery and is required for most compliance regimes | n/a |
| Backups | Separate key, separate account, object-lock | TLS |
| Internal service traffic | n/a | **mTLS everywhere**, no plaintext internal hops |
| Customer traffic | n/a | TLS 1.2/1.3 at the edge; edge→worker over a private network, mTLS at <span class="mat mat-v1">V1</span> |

## 23.6 Key management

- One KMS/HSM (cloud KMS, or Vault + HSM self-hosted). Keys never leave it.
- Distinct keys with distinct access policies for: secrets encryption, snapshot encryption, certificate private keys, backup encryption, image signing, token signing.
- Image signing key usable only by the builder service role; **require an approval or use a keyless/Fulcio flow with an identity-bound short-lived certificate** for the strongest posture.
- Key rotation schedule documented and rehearsed; support a dual-key grace period for every key so rotation is never a flag-day.

## 23.7 Audit logging

Every mutating action: actor (user/token/system), IP, user agent, action, resource, before/after diff (secrets redacted to key names only), outcome, request ID, timestamp. Append-only — no `UPDATE`/`DELETE` grants on the table for the application role; ship to a write-once store for compliance tiers.

Customer-visible audit log is a paid feature and also a support tool ("who deleted the production domain?").

## 23.8 Supply-chain security

**Yours:**
- Pin all dependencies by hash (`go.sum`, `Cargo.lock`, lockfiles). Renovate/Dependabot with review.
- Reproducible-ish builds of your own binaries; sign releases; SBOM for your own components.
- Base images for build/run rebuilt weekly and pinned by digest in runtime definitions.
- Two-person review on anything touching the agent, jailer invocation, seccomp filters, authz, or crypto.
- Restricted CI: no secrets in PR builds from forks; separate deploy credentials with OIDC federation.

**Customers':**
- SBOM generated per image; vulnerability scanning; provenance attestation; dependency-confusion protection at the mirror; notification when a shipped image gains a new critical CVE.

## 23.9 Security attack tree (platform-wide)

<figure class="mermaid-figure"><pre class="mermaid">graph TD
    ROOT[&quot;GOAL: compromise the platform or a tenant&quot;] --&gt; P1[Path 1: Escape a runtime sandbox]
    ROOT --&gt; P2[Path 2: Compromise the control plane]
    ROOT --&gt; P3[Path 3: Compromise the supply chain]
    ROOT --&gt; P4[Path 4: Abuse legitimate access]
    ROOT --&gt; P5[Path 5: Attack the network/edge]
    ROOT --&gt; P6[Path 6: Insider or credential theft]
    P1 --&gt; P1a[KVM/Firecracker 0-day → host root]
    P1 --&gt; P1b[Wasmtime JIT escape → wasm host process]
    P1 --&gt; P1c[Agent vuln via vsock/log parsing]
    P1 --&gt; P1d[Escape build sandbox]
    P1a --&gt; P1a1[Read other tenants&#x27; memory/rootfs on that host]
    P1a --&gt; P1a2[Steal worker mTLS cert → impersonate worker]
    P2 --&gt; P2a[AuthZ bypass / IDOR in API]
    P2 --&gt; P2b[SQL injection]
    P2 --&gt; P2c[SSRF from control plane, e.g. git URL / webhook URL]
    P2 --&gt; P2d[Compromise a control-plane dependency]
    P2 --&gt; P2e[Steal DB credentials]
    P3 --&gt; P3a[Malicious runtime definition or base image]
    P3 --&gt; P3b[Registry write access → backdoored image]
    P3 --&gt; P3c[Compromised platform dependency]
    P3 --&gt; P3d[Typosquatting in a tenant&#x27;s deps → tenant compromise]
    P4 --&gt; P4a[Crypto mining]
    P4 --&gt; P4b[Proxy/VPN abuse]
    P4 --&gt; P4c[Phishing sites on subdomains]
    P4 --&gt; P4d[Spam/DDoS origin]
    P4 --&gt; P4e[Resource exhaustion of shared components]
    P5 --&gt; P5a[DDoS the edge]
    P5 --&gt; P5b[TLS/cert attacks, ACME hijack]
    P5 --&gt; P5c[DNS hijack / subdomain takeover]
    P5 --&gt; P5d[Cache poisoning at the gateway]
    P6 --&gt; P6a[Stolen employee credential]
    P6 --&gt; P6b[Leaked PAT in a public repo]
    P6 --&gt; P6c[Malicious insider]
    style ROOT fill:#7f1d1d,color:#fff</pre></figure>

Selected mitigations for the less obvious branches:

| Branch | Mitigation |
|---|---|
| P1a2 worker cert theft | Worker certs are short-lived and node-bound; the control plane authorizes per-node and rejects reports about instances not assigned to that node; a stolen cert cannot read secrets for other workers' instances |
| P1c agent vuln | Agent treats all guest-originated bytes as untrusted opaque data; no parsing of guest content in the privileged process; fuzz the vsock framing |
| P2c SSRF from control plane | The control plane fetches user-supplied URLs (webhooks, git remotes, external registries). Route all such fetches through an egress proxy with DNS re-resolution pinning (defeat DNS rebinding), deny RFC1918/link-local/metadata, and enforce redirect limits with re-validation at each hop |
| P3a malicious runtime definition | Runtime definitions are platform-controlled, reviewed, signed, and pinned by digest. If you accept community definitions, they run in the same sandbox as user builds and get the same review as code |
| P5c subdomain takeover | When a project is deleted, its `*.helix.app` name must be quarantined (not immediately reusable) so an attacker cannot claim a subdomain a customer still has a CNAME pointing at. Also verify custom-domain ownership continuously, not just once |
| P5d cache poisoning | Do not cache by default at the edge. If you add caching, key on the full `Host` + path + `Vary` and forbid customer control of cache keys |
| P6b leaked PAT | GitHub secret-scanning partner program → automatic revocation on detection |

## 23.10 Compliance posture (forward-looking)

Design now so these are achievable later without rearchitecting: audit logs, RBAC, MFA, encryption at rest/in transit, data residency flag, access reviews, change management, vendor list, incident response plan. SOC 2 Type II typically becomes a sales requirement around your first serious enterprise deal; ISO 27001 for EU enterprise; GDPR obligations (DPA, subprocessor list, deletion workflow, data export) from the first EU customer.
