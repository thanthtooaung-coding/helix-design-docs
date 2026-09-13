---
title: "24. Abuse Prevention"
description: "Detecting and stopping mining, proxy abuse, phishing, scanning and DDoS from customer workloads."
sidebar:
  order: 24
---

This section is not optional. **A platform that runs arbitrary code for free is, from day one, a crypto-mining and phishing platform.** Every provider in this space has learned this the hard way. Budget real engineering and real human review time.

## 24.1 Layers

<figure class="mermaid-figure"><pre class="mermaid">graph TB
    S[Signup] --&gt; S1[Email verification, disposable-domain blocklist, phone/card for compute access]
    S1 --&gt; D[Deploy]
    D --&gt; D1[Static checks: image scan, known-miner binary hashes, suspicious entrypoints]
    D1 --&gt; R[Runtime]
    R --&gt; R1[Behavioral: CPU/network/DNS/connection profiles]
    R --&gt; R2[Network policy: port blocks, egress caps, reputation]
    R --&gt; R3[Content: phishing/malware scanning of served pages]
    R1 &amp; R2 &amp; R3 --&gt; A[Scoring engine]
    A --&gt;|low| A1[Log]
    A --&gt;|medium| A2[Throttle + notify + require verification]
    A --&gt;|high| A3[Suspend workload, human review]
    A --&gt;|critical| A4[Terminate, ban, preserve evidence, report]</pre></figure>

## 24.2 Detection signals

| Abuse | Signals |
|---|---|
| **Crypto mining** | Sustained ≥95% CPU with near-zero inbound HTTP; egress to known pool domains/IPs (stratum ports 3333/4444/5555/8888/14444); DNS lookups of known pool hostnames; process/binary hashes matching XMRig et al.; very high CPU-to-egress ratio; no listening socket on the expected port |
| **Proxy / VPN abuse** | High connection count to many distinct destination IPs; inbound:outbound byte ratio near 1:1; long-lived connections; CONNECT-like patterns; traffic to residential IP ranges |
| **Spam** | Outbound to ports 25/465/587 (blocked, but attempts are a signal); high-volume POSTs to mail APIs; sudden egress to many distinct MX hosts |
| **Port scanning** | Many SYNs to distinct (IP, port) pairs; high connection-failure ratio; sequential address patterns; conntrack table pressure |
| **DDoS origin** | Very high packet rate; low bytes-per-packet; spoofing attempts (drop with uRPF); UDP amplification patterns |
| **Phishing** | Page content resembling known brands (perceptual hashing of screenshots, favicon matching, form field names like `password`+brand terms); domains registered minutes before deploy; abuse reports; Google Safe Browsing / PhishTank feeds |
| **Malware hosting** | Served file hashes matching threat intel; high download-to-unique-IP ratios of executable content |
| **Free-tier farming** | Many accounts sharing IP/device fingerprint/card BIN/email pattern; identical deployments across accounts |
| **Brute forcing (as origin)** | Repeated auth failures at a single external destination from one instance |

## 24.3 Controls

**Preventive:**
- Email verification for any account; card verification (with a small auth hold) or phone verification before granting CPU beyond a token free allowance. This single control removes the majority of abuse.
- Default-deny outbound ports for free accounts except 80/443; open more as accounts age and verify.
- Hard egress bandwidth caps on free tier (e.g. 10 GiB/month, 10 Mbit/s burst).
- CPU quota per free account low enough that mining is economically pointless.
- No inbound path except through the platform's HTTP gateway (mining pools need outbound, so this alone does not stop mining, but it stops a lot else).

**Detective:**
- Per-instance resource profiles computed at the agent every 60 s (cheap counters, no deep packet inspection), shipped as features to a scoring service.
- DNS query analysis at the platform resolver.
- Netflow-style aggregates (destination ASN distribution, unique destination count, port entropy).
- Periodic crawl of customer-served pages for phishing/malware signatures.
- Third-party abuse report intake (`abuse@`), handled with an SLA. **Have this from day one** — your upstream provider will forward complaints and will null-route you if you ignore them.

**Responsive, graduated:**

| Level | Action |
|---|---|
| 1 | Log and score. No user impact |
| 2 | Throttle CPU/egress; email the user; require verification to lift |
| 3 | Suspend the specific workload; project remains, data intact; user notified with a reason and an appeal path |
| 4 | Suspend the organization; preserve evidence; human review within 24 h |
| 5 | Terminate, ban payment instrument and device fingerprint, report to authorities where required |

**False positives are serious.** A legitimate ML inference workload looks exactly like mining on CPU metrics alone. Never auto-terminate on a single signal; require multiple independent signals plus (above level 2) human review. Provide a fast appeal path and a human to answer it. Publish an acceptable use policy that actually describes these categories.

## 24.4 Detecting a compromised platform host

Separate from tenant abuse: signals that a tenant escaped.
- Host-level eBPF/auditd monitoring for unexpected syscalls from a Firecracker process, any `execve` outside the expected set, any file access outside the jail, any new listening socket.
- File integrity monitoring on the agent binary, kernel, jailer, and config.
- Unexpected outbound connections from the host's own IP (as opposed to the NAT pool).
- Any host process running as root that is not on the allowlist.
- Alert as P0 and **isolate the host automatically**: cordon, cut egress, snapshot for forensics, do not reboot (memory is evidence).

## 24.5 IP reputation

Your NAT egress IPs will get listed. Mitigations: separate IP pools for free vs paid; per-org dedicated egress IPs at higher tiers; monitor your ranges against major blocklists and have a delisting runbook; do not put platform infrastructure and customer egress on the same ranges; publish accurate WHOIS/abuse contacts.
