---
title: "38. Distributed Systems Concerns"
description: "Idempotency, consistency, fencing, retries, delivery semantics, and the deployment state machine."
sidebar:
  order: 38
---

## 38.1 Idempotency

| Layer | Mechanism |
|---|---|
| Public API | `Idempotency-Key` header + `idempotency_keys` table ([§2.5](../02-control-plane/#25-idempotency-and-api-level-correctness)) |
| Queue consumers | Business-level dedup keys; every handler is written to be safely re-runnable |
| Agent assignments | `instance_id` is the key; a repeat is a no-op |
| Usage events | `dedup_key` unique index |
| Webhook ingestion | Provider delivery ID in a replay cache |
| Outbound webhooks | We send an idempotency key; customers dedupe |
| Build jobs | Digest-addressed output makes duplicates harmless |

**Design rule:** every message handler answers "what happens if this runs twice?" in a comment. If the answer is not "nothing bad," it is a bug.

## 38.2 Consistency model

| Data | Model |
|---|---|
| Deployment/release state | **Strong** (single Postgres primary, serializable where needed) |
| Routing table | **Eventually consistent**, bounded by generation propagation (target < 2 s p99) |
| Worker capacity | **Eventually consistent** with optimistic reservation; the agent is the final authority |
| Usage records | Eventually consistent, at-least-once with dedup |
| Metrics/logs | Best-effort |
| Secrets | Strong |

The routing table being eventually consistent means: for up to a couple of seconds after a deploy, some requests may hit the old release. For a blue-green/canary rollout this is fine and expected. Document it — users occasionally build things that assume atomic cutover.

## 38.3 Distributed locks, leases, and fencing

Locks are used sparingly and **never as the only correctness guard**.

| Need | Mechanism |
|---|---|
| Scheduler leadership | Postgres advisory lock with a lease row (`leader_id, epoch, expires_at`), renewed every 2 s, TTL 5 s |
| Deployment ownership | `SELECT ... FOR UPDATE SKIP LOCKED` — no external lock needed |
| Cold-start single-flight | Redis `SETNX` with TTL — losing it costs a duplicate cold start, nothing more |
| Worker identity | `workers.generation`, incremented on registration |

**Fencing tokens are mandatory.** The classic failure: leader A acquires the lease, stalls (GC pause, disk stall), lease expires, leader B takes over, then A wakes and issues a stale command. Guard:
- Every `AssignInstance` carries `leader_epoch`.
- The agent records the highest epoch it has seen and rejects anything lower.
- Every write to `workers`/`instances` from the scheduler includes `AND leader_epoch >= $current`.

Without this, a stalled scheduler can resurrect instances that were deliberately stopped.

## 38.4 Retries and backoff

Standard everywhere: exponential backoff, base 100 ms–1 s depending on the operation, cap 30–60 s, **full jitter** (`sleep = random(0, min(cap, base * 2^attempt))`). Equal jitter is acceptable; no jitter is a thundering-herd bug.

Budget-based retries: each request carries a retry budget (Envoy's `retry_budget`) so a broad failure does not double or triple the load on an already-struggling backend. This is the detail that turns a partial outage into a total one when omitted.

Circuit breakers between services: after N consecutive failures, fail fast for a cooldown, then half-open.

## 38.5 Dead letter queues

Every JetStream consumer has `max_deliver`. On exhaustion the message goes to `dlq.<original.subject>` with the failure history attached. A DLQ is not a graveyard: alert on non-empty DLQs, provide an operator tool to inspect and replay, and treat any DLQ message as a bug to triage. Common DLQ residents: builds for deleted projects, assignments for decommissioned workers, usage events for closed orgs. Each should be filtered *before* it becomes a DLQ entry.

## 38.6 Delivery semantics

**Everything is at-least-once.** Exactly-once does not exist across a network boundary; what exists is at-least-once delivery plus idempotent processing, which is what we build ([§38.1](#381-idempotency)).

The one place that looks like it needs exactly-once is billing. It does not: `dedup_key` on `usage_records` makes replay a no-op, and the reconciliation job catches gaps. Never architect around a broker's "exactly-once" marketing claim.

## 38.7 Other hazards

| Hazard | Manifestation here | Mitigation |
|---|---|---|
| **Race conditions** | Two schedulers placing on the same worker's last slot | Optimistic reservation with a conditional update; agent rejects what it cannot honor |
| **Race: deploy + rollback simultaneously** | Two deployments racing to set `current_release_id` | Transition guards + `FOR UPDATE` on the environment row; last writer wins deterministically and is audited |
| **Split brain** | Two regions both promoting Postgres | Manual promotion only, with a runbook |
| **Clock skew** | Usage windows misaligned; certificate validation; lease expiry | NTP/chrony on every host, alert on skew > 1 s; leases use monotonic clocks locally and compare only on one machine's clock (the DB's `now()`); usage buckets assigned by the aggregator |
| **Stale state** | Gateway serving a removed endpoint | Generation numbers + TTL on cached entries + connection-failure ejection |
| **Duplicate workers** | A cloned VM image with the same worker identity | Identity bound to a hardware/instance attribute and a one-time bootstrap token; duplicate registration bumps `generation` and fences the older one |
| **Zombie instances** | VM running, control plane forgot about it | Agent reports everything it runs; control plane returns "not desired" → agent stops it after a grace period. The grace period exists so a control-plane bug does not instantly kill production |
| **Thundering herd on cold start** | 500 requests → 500 VMs | Single-flight + activation concurrency caps |
| **Cascading failure** | Registry slow → pulls slow → agents miss heartbeats → fenced → more churn | Separate task pools in the agent; heartbeats never share a thread with pulls; circuit breaker on the registry; fencing requires *heartbeat* loss, not slowness |
| **Metastable failure** | Retry storms keep a recovered system down | Retry budgets, load shedding at the gateway, admission control that sheds before queueing |

## 38.8 Deployment state machine

<figure class="mermaid-figure"><pre class="mermaid">stateDiagram-v2
    [*] --&gt; QUEUED : created
    QUEUED --&gt; BUILDING : build worker claims
    QUEUED --&gt; CANCELLED : user cancel
    QUEUED --&gt; FAILED : validation / quota (terminal)
    BUILDING --&gt; BUILT : image pushed, signed, policy pass
    BUILDING --&gt; BUILD_FAILED : compile error, test failure, OOM
    BUILDING --&gt; BUILD_TIMEOUT : wall clock exceeded
    BUILDING --&gt; CANCELLED : user cancel / superseded
    BUILDING --&gt; QUEUED : infra failure, attempt &lt; max (retry)
    BUILT --&gt; POLICY_FAILED : signature/scan policy blocks
    BUILT --&gt; SCHEDULING : release created
    SCHEDULING --&gt; STARTING : instances assigned
    SCHEDULING --&gt; SCHEDULE_TIMEOUT : no capacity before deadline
    SCHEDULING --&gt; CANCELLED
    STARTING --&gt; READY : min required instances healthy
    STARTING --&gt; START_FAILED : probe timeout / crashloop / pull failure
    STARTING --&gt; CANCELLED
    READY --&gt; ROLLING_OUT : traffic shift begins
    ROLLING_OUT --&gt; ACTIVE : 100% traffic
    ROLLING_OUT --&gt; ROLLING_BACK : auto-rollback triggered (error rate / latency)
    ROLLING_BACK --&gt; SUPERSEDED
    ACTIVE --&gt; SUPERSEDED : newer deployment took over
    ACTIVE --&gt; STOPPING : project/env deleted or manually stopped
    SUPERSEDED --&gt; DRAINING : old instances draining
    DRAINING --&gt; STOPPED
    STOPPING --&gt; STOPPED
    BUILD_FAILED --&gt; [*]
    BUILD_TIMEOUT --&gt; [*]
    POLICY_FAILED --&gt; [*]
    SCHEDULE_TIMEOUT --&gt; [*]
    START_FAILED --&gt; [*]
    FAILED --&gt; [*]
    CANCELLED --&gt; [*]
    STOPPED --&gt; [*]</pre></figure>

**Implementation rules for the state machine:**

1. **Transitions are guarded, single-statement, and return affected rows.**
   ```sql
   UPDATE deployments
      SET state = 'BUILDING', started_at = now(), updated_at = now()
    WHERE id = $1 AND state = 'QUEUED'
   RETURNING id;
   ```
   Zero rows → someone else did it; back off, do not retry blindly.

2. **The transition table is data**, validated at startup:
   ```go
   var allowed = map[State][]State{
       QUEUED:   {BUILDING, CANCELLED, FAILED},
       BUILDING: {BUILT, BUILD_FAILED, BUILD_TIMEOUT, CANCELLED, QUEUED},
       ...
   }
   ```
   A test asserts every state is reachable and every terminal state has no outgoing edges.

3. **Side effects happen after the transition commits**, via the outbox — never inside the transaction, and never before. A side effect that fails is retried by the outbox relay; a transition that fails leaves no side effect.

4. **Every non-terminal state has a timeout** and a janitor that moves it to a failure state with a clear reason. A deployment stuck in `SCHEDULING` forever is the worst user experience the platform can produce.

5. **Terminal states are immutable.** A rollback is a *new* deployment, never a mutation of an old one.

6. **`state_history` is appended on every transition** (a separate table or a `jsonb` array), because "when did it get stuck" is the first question in every support ticket.
