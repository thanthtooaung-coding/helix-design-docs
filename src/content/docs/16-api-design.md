---
title: "16. API Design"
description: "REST conventions, authentication, authorization, the core endpoints with examples, and error shapes."
sidebar:
  order: 16
---

## 16.1 Conventions

- Base: `https://api.helix.dev/v1`
- JSON only. `snake_case` fields. RFC 3339 timestamps with `Z`.
- Every response carries `X-Request-Id`; every error is RFC 9457 `application/problem+json`.
- Pagination: cursor-based (`?limit=50&cursor=...` → `{data: [...], next_cursor: "..."}`). Never offset-based — offsets break under concurrent writes and get slow.
- Mutating endpoints accept `Idempotency-Key` ([§2.5](../02-control-plane/#25-idempotency-and-api-level-correctness)).
- Versioning: URL major version + `Helix-Version: 2026-09-01` date header for minor breaking changes, Stripe-style. Old date versions keep working; a compatibility shim layer translates.
- Long-running operations return `202` with the resource in a non-terminal state; clients poll or stream.

## 16.2 Authentication

| Credential | Use | Transport |
|---|---|---|
| Session cookie (`__Host-helix_session`, `Secure; HttpOnly; SameSite=Lax`) | Dashboard | Cookie + CSRF token on mutations |
| Personal access token `hxp_<prefix>_<secret>` | CLI, scripts | `Authorization: Bearer` |
| Machine token `hxm_...` scoped to an org/project | CI | `Authorization: Bearer` |
| OAuth 2.0 (auth code + PKCE) | Third-party integrations | Bearer |
| mTLS + SPIFFE | Worker agents (internal gRPC only) | Client cert |
| GitHub App installation JWT | Git operations | Internal |

Token format matters: the `hxp_<prefix>_<secret>` shape lets you (a) look up by `prefix` without a table scan, (b) detect leaked tokens in public repos via GitHub's secret scanning partner program — **register for this, it is free and catches real leaks**, (c) revoke by prefix. Store only `sha256(secret)`.

## 16.3 Authorization

RBAC evaluated in one place:

```text
authorize(principal, action, resource) →
   1. resolve principal's org membership role
   2. resolve token scopes (∩ with role — a token can never exceed its user's role)
   3. resolve resource's org_id; must match
   4. check role→permission matrix
   5. check resource-level constraints (protected environment, project-scoped token)
   6. deny by default
```

| Role | Permissions |
|---|---|
| `owner` | Everything, including billing, org deletion, member removal |
| `admin` | Everything except billing and org deletion |
| `developer` | Create/deploy projects, read secrets they created, rollback; **cannot** read other secrets, manage domains on protected envs, or change quotas |
| `viewer` | Read-only, no secret values, no logs containing secrets |
| `billing` | Billing and usage only |

Additional rules: production environments can be marked `protected`, requiring `admin` to deploy or rollback. Secret *values* are never returned by any API after creation — only metadata (key, scope, last updated). This is non-negotiable; "let me just show it in the UI" is how secrets end up in browser history and screenshots.

## 16.4 Core endpoints

## Projects

```http
POST /v1/projects
Authorization: Bearer hxp_...
Idempotency-Key: 0f2c...
Content-Type: application/json

{
  "name": "my-api",
  "slug": "my-api",
  "repo": {
    "provider": "github",
    "full_name": "acme/my-api",
    "production_branch": "main",
    "root_directory": "."
  },
  "regions": ["sin1"],
  "auto_deploy": true
}
```

```http
201 Created
{
  "id": "prj_01J8XQ2H3K5M7P9R1T3V5W7Y9A",
  "org_id": "org_01J8W...",
  "name": "my-api",
  "slug": "my-api",
  "repo": { "provider":"github", "full_name":"acme/my-api",
            "production_branch":"main", "root_directory":"." },
  "environments": [
    {"id":"env_01J8...","name":"production","kind":"production"},
    {"id":"env_01J8...","name":"preview","kind":"preview"}
  ],
  "default_domain": "my-api-acme.helix.app",
  "regions": ["sin1"],
  "auto_deploy": true,
  "created_at": "2026-09-13T04:12:00Z"
}
```

```http
GET /v1/projects?limit=20&cursor=eyJpZCI6InByal8...
200 OK
{ "data": [ {...}, {...} ], "next_cursor": "eyJpZCI6..." }

GET /v1/projects/prj_01J8XQ2H3K5M7P9R1T3V5W7Y9A
200 OK
{ ...project..., "current_release": { "production": "rel_01J8...", "preview": null },
  "stats": { "instances_running": 2, "requests_24h": 148203, "error_rate_24h": 0.0021 } }

PATCH  /v1/projects/{id}
DELETE /v1/projects/{id}      → 202, async teardown (stop instances, release domains, GC images)
```

## Deployments

```http
POST /v1/deployments
Idempotency-Key: 7b1e...

{
  "project_id": "prj_01J8XQ...",
  "environment": "production",
  "source": {
    "kind": "git",
    "ref": "refs/heads/main",
    "commit_sha": "9f2c1d0a8b7e6f5d4c3b2a1908f7e6d5c4b3a291"
  },
  "config_override": { "scaling": { "min_instances": 1 } }
}
```

```http
202 Accepted
Location: /v1/deployments/dep_01J8Y...

{
  "id": "dep_01J8Y3K5M7P9R1T3V5W7Y9AB",
  "project_id": "prj_01J8XQ...",
  "environment": "production",
  "state": "QUEUED",
  "trigger": "api",
  "source": { "kind":"git", "ref":"refs/heads/main", "commit_sha":"9f2c1d0a..." },
  "build": null,
  "release": null,
  "urls": { "logs": "/v1/deployments/dep_01J8Y.../logs",
            "events": "/v1/deployments/dep_01J8Y.../events" },
  "created_at": "2026-09-13T04:14:22Z"
}
```

```http
GET /v1/deployments/dep_01J8Y3K5M7P9R1T3V5W7Y9AB
200 OK
{
  "id": "dep_01J8Y...",
  "state": "READY",
  "state_history": [
    {"state":"QUEUED",    "at":"2026-09-13T04:14:22Z"},
    {"state":"BUILDING",  "at":"2026-09-13T04:14:25Z"},
    {"state":"BUILT",     "at":"2026-09-13T04:16:41Z"},
    {"state":"SCHEDULING","at":"2026-09-13T04:16:42Z"},
    {"state":"STARTING",  "at":"2026-09-13T04:16:44Z"},
    {"state":"READY",     "at":"2026-09-13T04:16:51Z"}
  ],
  "build": {
    "id": "bld_01J8Y...", "state": "SUCCEEDED",
    "duration_ms": 136000, "cache_hit_ratio": 0.82,
    "image": { "digest": "sha256:4c1f...", "size_bytes": 214958080,
               "scan": { "critical":0, "high":2, "medium":11 } }
  },
  "release": {
    "id": "rel_01J8Y...",
    "instances": { "desired": 1, "ready": 1 },
    "url": "https://my-api-acme.helix.app"
  },
  "durations_ms": { "queue": 3000, "build": 136000, "schedule": 2000, "start": 7000, "total": 148000 }
}
```

```http
POST /v1/deployments/{id}/cancel
202 Accepted    { "id": "...", "state": "CANCELLING" }
409 Conflict    if already terminal

POST /v1/deployments/{id}/rollback
{ "reason": "5xx spike after deploy" }
202 Accepted
{ "id": "dep_01J8Z...", "trigger": "rollback",
  "rolled_back_to": { "deployment_id": "dep_01J8W...", "release_id": "rel_01J8W..." },
  "env_diff": [ {"key":"FEATURE_X","from":"true","to":"false"} ],
  "state": "SCHEDULING" }

POST /v1/projects/{id}/promote
{ "from_deployment": "dep_01J8Y...", "to_environment": "production" }

GET  /v1/deployments/{id}/logs?source=build&follow=true&since=2026-09-13T04:14:00Z
     Accept: text/event-stream
     → SSE stream of {"ts":"...","stream":"stdout","seq":1042,"line":"..."}

GET  /v1/deployments/{id}/logs?source=runtime&instance=ins_01J8...&limit=1000
     200 OK  { "data":[...], "next_cursor":"..." }
```

## Domains

```http
POST /v1/domains
{ "project_id":"prj_01J8XQ...", "environment":"production", "hostname":"api.acme.com" }

201 Created
{
  "id": "dom_01J8A...",
  "hostname": "api.acme.com",
  "status": "pending_verification",
  "verification": {
    "method": "dns_txt",
    "record": { "type":"TXT", "name":"_helix-challenge.api.acme.com",
                "value":"helix-verify=7f3a91c2..." },
    "alternative": { "type":"CNAME", "name":"api.acme.com", "value":"cname.helix.app" }
  },
  "certificate": null
}

POST   /v1/domains/{id}/verify        → triggers an immediate check
GET    /v1/domains/{id}
DELETE /v1/domains/{id}               → 204; cert revoked, routes removed
```

## Environment variables and secrets

```http
POST /v1/environment-variables
{ "project_id":"prj_...", "environment":"production",
  "key":"LOG_LEVEL", "value":"info", "scope":"runtime" }
201 Created { "id":"evar_01J8...", "key":"LOG_LEVEL", "value":"info", ... }

POST /v1/secrets
{ "project_id":"prj_...", "environment":"production",
  "key":"DATABASE_URL", "value":"postgres://...", "scope":"runtime" }
201 Created
{ "id":"sec_01J8...", "key":"DATABASE_URL", "scope":"runtime",
  "version":1, "created_at":"..." }          // note: no value echoed back, ever

GET    /v1/secrets?project_id=prj_...        → metadata only
PATCH  /v1/secrets/{id}                       → new version; requires redeploy to take effect
DELETE /v1/environment-variables/{id}         → 204
DELETE /v1/secrets/{id}                       → 204
```

A deliberate design point: **changing an env var or secret does not restart running instances.** It applies to the next deployment. Silent restarts on config change cause surprise outages. Provide `POST /v1/projects/{id}/redeploy` to apply immediately, and show a "config changed since last deploy" banner.

## Instances, logs, metrics

```http
GET /v1/releases/{id}/instances
GET /v1/instances/{id}
POST /v1/instances/{id}/restart
GET /v1/projects/{id}/metrics?metric=request_duration_p95&from=...&to=...&step=60s
GET /v1/projects/{id}/usage?from=2026-09-01&to=2026-09-30&group_by=metric
```

## Webhooks (outbound to customers)

```http
POST /v1/webhooks
{ "project_id":"prj_...", "url":"https://acme.com/hooks/helix",
  "events":["deployment.succeeded","deployment.failed","instance.crashed"] }
```
Signed with HMAC-SHA256 over `timestamp.body`, header `Helix-Signature: t=...,v1=...`, with retries and exponential backoff, and a replay-protection window. Same design as Stripe's — do not invent a new one.

## 16.5 Errors

```json
{
  "type": "https://docs.helix.dev/errors/quota_exceeded",
  "title": "Quota exceeded",
  "status": 429,
  "detail": "Your plan allows 10 concurrent instances; this deployment requires 15.",
  "code": "quota_exceeded",
  "request_id": "req_01J8Y...",
  "errors": [
    { "path": "scaling.max_instances", "code": "above_plan_limit", "limit": 10, "given": 15 }
  ],
  "docs_url": "https://docs.helix.dev/limits"
}
```

Error codes are a stable API surface. Version them like endpoints.

## 16.6 Rate limiting

| Scope | Default |
|---|---|
| Per token, all endpoints | 600 req/min |
| `POST /deployments` | 30/min per project, 100/min per org |
| Log streaming connections | 10 concurrent per org |
| Unauthenticated (login, signup) | 10/min per IP, plus progressive delay and CAPTCHA after failures |

Return `X-RateLimit-Limit`, `-Remaining`, `-Reset`, and `Retry-After` on 429. Implement with a sliding-window counter in Redis; fail *open* for reads and *closed* for expensive writes if Redis is unavailable.

## 16.7 gRPC (internal only)

`WorkerService` ([§3.5](../03-compute-plane/#35-agent--control-plane-protocol)), `SchedulerService`, `RouteService`, `LogIngestService`. Never exposed publicly. mTLS with SPIFFE IDs; authorization by SPIFFE ID per method.
