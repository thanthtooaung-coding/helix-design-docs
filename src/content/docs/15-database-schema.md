---
title: "15. Database Schema"
description: "Full PostgreSQL DDL for 29 tables, an ER diagram, and the modeling decisions behind them."
sidebar:
  order: 15
---

## 15.1 Conventions

- PostgreSQL 16+.
- Primary keys are ULIDs stored as `text` with a type prefix (`prj_01J8X...`) for human-debuggable IDs and natural time ordering, **or** `uuid` v7 if you prefer native types. Prefixed ULIDs are chosen here because they make logs and support enormously easier.
- Every tenant-scoped table carries `org_id` **denormalized**, even when derivable, so that row-level security and every query can filter on it without joins.
- `created_at`/`updated_at` `timestamptz NOT NULL DEFAULT now()`.
- Soft delete via `deleted_at` only where users expect restore; otherwise hard delete.
- `jsonb` for open-ended structures (resolved specs, provider payloads), with CHECK constraints or schema validation at the application layer.
- **Row-level security enabled** on tenant tables, with `app.current_org_id` set per connection/transaction. This is a second line of defense against a missing `WHERE org_id = ...` — the most common multi-tenant data-leak bug.

Two naming notes against the original requirement list: **`releases`** is the table you might have called `deployment_versions` (an immutable runnable artifact + config), and **`instances`** is the one you might have called `microvms` — it covers both Firecracker and WASM instances, which is why it is not named after a VM. The DDL below is grouped for readability rather than in strict dependency order; a few forward foreign-key references (e.g. `projects.git_installation_id`) are added with `ALTER TABLE` in the real migration.

## 15.2 ER diagram

<figure class="mermaid-figure"><pre class="mermaid">erDiagram
    ORGANIZATIONS ||--o{ MEMBERSHIPS : has
    USERS ||--o{ MEMBERSHIPS : belongs_to
    ORGANIZATIONS ||--o{ TEAMS : has
    TEAMS ||--o{ TEAM_MEMBERS : has
    USERS ||--o{ TEAM_MEMBERS : in
    ORGANIZATIONS ||--o{ PROJECTS : owns
    ORGANIZATIONS ||--o{ QUOTAS : constrained_by
    ORGANIZATIONS ||--o{ API_TOKENS : issues
    ORGANIZATIONS ||--o{ AUDIT_LOGS : records
    ORGANIZATIONS ||--o{ USAGE_RECORDS : accrues
    ORGANIZATIONS ||--o{ GIT_INSTALLATIONS : connects
    PROJECTS ||--o{ ENVIRONMENTS : has
    PROJECTS ||--o{ DEPLOYMENTS : has
    PROJECTS ||--o{ DOMAINS : has
    PROJECTS ||--o{ ENV_VARS : has
    PROJECTS ||--o{ SECRETS : has
    PROJECTS ||--o{ BUILD_CACHES : has
    ENVIRONMENTS ||--o{ DEPLOYMENTS : targets
    ENVIRONMENTS ||--o| RELEASES : current_release
    DEPLOYMENTS ||--o| BUILDS : produces
    DEPLOYMENTS ||--o| RELEASES : yields
    BUILDS ||--o| IMAGES : produces
    IMAGES ||--o{ IMAGE_ARTIFACTS : has
    RELEASES ||--o{ INSTANCES : runs
    RELEASES }o--|| RUNTIME_VERSIONS : uses
    RUNTIMES ||--o{ RUNTIME_VERSIONS : has
    WORKERS ||--o{ INSTANCES : hosts
    REGIONS ||--o{ WORKERS : contains
    REGIONS ||--o{ ZONES : contains
    ZONES ||--o{ WORKERS : contains
    DOMAINS ||--o| CERTIFICATES : secured_by
    DOMAINS }o--|| ENVIRONMENTS : routes_to
    INSTANCES ||--o{ USAGE_RECORDS : generates</pre></figure>

## 15.3 DDL

## Identity and tenancy

```sql
CREATE TABLE users (
  id              text PRIMARY KEY,                 -- usr_01J8...
  email           citext NOT NULL UNIQUE,
  email_verified  boolean NOT NULL DEFAULT false,
  name            text,
  avatar_url      text,
  password_hash   text,                             -- NULL if SSO-only
  mfa_secret_enc  bytea,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

CREATE TABLE organizations (
  id              text PRIMARY KEY,                 -- org_01J8...
  slug            citext NOT NULL UNIQUE,
  name            text NOT NULL,
  plan            text NOT NULL DEFAULT 'free',
  billing_ref     text,                             -- Stripe customer id
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','past_due','suspended','closed')),
  suspended_reason text,
  data_residency  text,                             -- NULL | 'eu' | 'sg' ...
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','developer','viewer','billing')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX ON memberships (user_id);

CREATE TABLE teams (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE team_members (
  team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE api_tokens (
  id           text PRIMARY KEY,                    -- tok_01J8...
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      text REFERENCES users(id) ON DELETE CASCADE,  -- NULL = machine token
  name         text NOT NULL,
  token_hash   bytea NOT NULL,                      -- sha256 of the secret half
  prefix       text NOT NULL,                       -- first 8 chars, for display/lookup
  scopes       text[] NOT NULL DEFAULT '{}',
  project_id   text,                                -- NULL = org-wide
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON api_tokens (prefix);
```

## Projects, environments, config

```sql
CREATE TABLE projects (
  id                 text PRIMARY KEY,              -- prj_01J8...
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug               citext NOT NULL,
  name               text NOT NULL,
  git_installation_id text REFERENCES git_installations(id) ON DELETE SET NULL,
  repo_provider      text CHECK (repo_provider IN ('github','gitlab','bitbucket')),
  repo_external_id   text,
  repo_full_name     text,
  production_branch  text NOT NULL DEFAULT 'main',
  root_directory     text NOT NULL DEFAULT '.',
  auto_deploy        boolean NOT NULL DEFAULT true,
  preview_enabled    boolean NOT NULL DEFAULT true,
  default_regions    text[] NOT NULL DEFAULT '{}',
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE environments (
  id                 text PRIMARY KEY,              -- env_01J8...
  project_id         text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id             text NOT NULL,
  name               text NOT NULL,                 -- production | preview | staging | ...
  kind               text NOT NULL CHECK (kind IN ('production','preview','custom')),
  git_ref            text,                          -- branch/PR for preview envs
  current_release_id text,                          -- FK added after releases
  protected          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,                   -- preview auto-cleanup
  UNIQUE (project_id, name)
);

CREATE TABLE env_vars (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id      text NOT NULL,
  environment text,                                  -- NULL = all environments
  key         text NOT NULL CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  value       text NOT NULL,
  scope       text NOT NULL DEFAULT 'runtime'
              CHECK (scope IN ('runtime','build','both')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment, key, scope)
);

CREATE TABLE secrets (
  id             text PRIMARY KEY,                   -- sec_01J8...
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id         text NOT NULL,
  environment    text,
  key            text NOT NULL CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  ciphertext     bytea NOT NULL,                     -- AES-256-GCM
  nonce          bytea NOT NULL,
  dek_id         text NOT NULL REFERENCES data_keys(id),
  scope          text NOT NULL DEFAULT 'runtime'
                 CHECK (scope IN ('runtime','build','both')),
  version        int  NOT NULL DEFAULT 1,
  last_rotated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment, key, scope)
);

CREATE TABLE data_keys (                              -- envelope encryption
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wrapped_key   bytea NOT NULL,                      -- DEK encrypted by KMS CMK
  kms_key_id    text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz
);
```

## Runtimes

```sql
CREATE TABLE runtimes (
  id           text PRIMARY KEY,                     -- rt_java
  name         text NOT NULL UNIQUE,                 -- java
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('firecracker','wasm')),
  status       text NOT NULL DEFAULT 'ga'
               CHECK (status IN ('ga','beta','experimental','deprecated')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runtime_versions (
  id                text PRIMARY KEY,                -- rtv_java_21
  runtime_id        text NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  version           text NOT NULL,                   -- "21"
  definition        jsonb NOT NULL,                  -- the RuntimeDefinition document
  definition_hash   bytea NOT NULL,
  build_image       text NOT NULL,                   -- pinned by digest
  run_image         text NOT NULL,
  architectures     text[] NOT NULL DEFAULT '{amd64}',
  status            text NOT NULL DEFAULT 'ga',
  deprecated_after  timestamptz,
  eol_after         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (runtime_id, version)
);
```

## Deployments, builds, images, releases

```sql
CREATE TABLE deployments (
  id               text PRIMARY KEY,                 -- dep_01J8...
  org_id           text NOT NULL,
  project_id       text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id   text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  state            text NOT NULL,                    -- see §38.8
  trigger          text NOT NULL
                   CHECK (trigger IN ('git_push','git_pr','cli','api','rollback','redeploy','promote')),
  actor_user_id    text REFERENCES users(id),
  source_kind      text NOT NULL CHECK (source_kind IN ('git','upload','image')),
  git_commit_sha   text,
  git_ref          text,
  git_commit_msg   text,
  git_author       text,
  upload_key       text,                             -- S3 key for tarball
  config_raw       text,                             -- the helix.yaml as submitted
  config_resolved  jsonb,                            -- fully resolved spec
  config_hash      bytea,
  build_id         text,
  release_id       text,
  idempotency_key  text,
  error_code       text,
  error_message    text,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  ready_at         timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON deployments (project_id, created_at DESC);
CREATE INDEX ON deployments (state) WHERE state NOT IN ('ACTIVE','STOPPED','FAILED','CANCELLED');
CREATE UNIQUE INDEX ON deployments (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE builds (
  id                text PRIMARY KEY,                -- bld_01J8...
  org_id            text NOT NULL,
  deployment_id     text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  project_id        text NOT NULL,
  state             text NOT NULL,                   -- QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED|TIMED_OUT
  attempt           int  NOT NULL DEFAULT 1,
  builder_id        text,                            -- build worker id
  lease_expires_at  timestamptz,
  cancel_requested  boolean NOT NULL DEFAULT false,
  runtime_version_id text REFERENCES runtime_versions(id),
  image_id          text,
  exit_code         int,
  failure_class     text,                            -- user_error|infra|timeout|policy
  error_message     text,
  log_object_key    text,
  cpu_seconds       numeric,
  peak_memory_bytes bigint,
  cache_hit_ratio   numeric,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON builds (state, lease_expires_at) WHERE state = 'RUNNING';

CREATE TABLE images (
  id             text PRIMARY KEY,                   -- img_01J8...
  org_id         text NOT NULL,
  project_id     text NOT NULL,
  repository     text NOT NULL,                      -- org_slug/project_slug
  digest         text NOT NULL,                      -- sha256:...
  architecture   text NOT NULL,
  size_bytes     bigint NOT NULL,
  layer_count    int NOT NULL,
  config         jsonb NOT NULL,                     -- OCI image config
  signed         boolean NOT NULL DEFAULT false,
  signature_ref  text,
  sbom_key       text,
  scan_status    text,                               -- pending|clean|vulnerable|error
  scan_summary   jsonb,                              -- {critical:1,high:4,...}
  scanned_at     timestamptz,
  source         text NOT NULL DEFAULT 'build'
                 CHECK (source IN ('build','import')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository, digest)
);

CREATE TABLE releases (
  id                 text PRIMARY KEY,               -- rel_01J8...
  org_id             text NOT NULL,
  project_id         text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id     text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  deployment_id      text NOT NULL REFERENCES deployments(id),
  image_id           text REFERENCES images(id),
  runtime_kind       text NOT NULL CHECK (runtime_kind IN ('firecracker','wasm')),
  wasm_artifact_key  text,                           -- for wasm releases
  spec               jsonb NOT NULL,                 -- immutable ReleaseSpec
  spec_hash          bytea NOT NULL,
  env_snapshot_id    text,                           -- pinned env set version
  min_instances      int NOT NULL DEFAULT 0,
  max_instances      int NOT NULL DEFAULT 10,
  target_concurrency int NOT NULL DEFAULT 50,
  vcpu               numeric NOT NULL,
  memory_mib         int NOT NULL,
  regions            text[] NOT NULL,
  state              text NOT NULL
                     CHECK (state IN ('pending','ready','active','draining','retired','failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz
);
CREATE INDEX ON releases (project_id, created_at DESC);
CREATE INDEX ON releases (state) WHERE state IN ('ready','active','draining');

ALTER TABLE environments
  ADD CONSTRAINT fk_current_release
  FOREIGN KEY (current_release_id) REFERENCES releases(id);
```

## Infrastructure

```sql
CREATE TABLE regions (
  id          text PRIMARY KEY,                      -- sin1
  name        text NOT NULL,
  continent   text NOT NULL,
  country     text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','draining','disabled')),
  is_default  boolean NOT NULL DEFAULT false
);

CREATE TABLE zones (
  id        text PRIMARY KEY,                        -- sin1-a
  region_id text NOT NULL REFERENCES regions(id),
  status    text NOT NULL DEFAULT 'active'
);

CREATE TABLE workers (
  id                 text PRIMARY KEY,               -- wrk_01J8...
  region_id          text NOT NULL REFERENCES regions(id),
  zone_id            text NOT NULL REFERENCES zones(id),
  hostname           text NOT NULL,
  internal_ip        inet NOT NULL,
  architecture       text NOT NULL DEFAULT 'amd64',
  cpu_cores          int NOT NULL,
  cpu_threads        int NOT NULL,
  memory_mib         int NOT NULL,
  disk_gib           int NOT NULL,
  allocatable_vcpu   numeric NOT NULL,
  allocatable_mib    int NOT NULL,
  allocated_vcpu     numeric NOT NULL DEFAULT 0,
  allocated_mib      int NOT NULL DEFAULT 0,
  instance_count     int NOT NULL DEFAULT 0,
  max_instances      int NOT NULL DEFAULT 600,
  role               text NOT NULL DEFAULT 'runtime'
                     CHECK (role IN ('runtime','build','both')),
  status             text NOT NULL
                     CHECK (status IN ('provisioning','ready','cordoned','draining','unhealthy','fenced','decommissioned')),
  agent_version      text,
  kernel_version     text,
  fc_version         text,
  cpu_template       text,                           -- for snapshot compatibility
  labels             jsonb NOT NULL DEFAULT '{}',
  last_heartbeat_at  timestamptz,
  generation         bigint NOT NULL DEFAULT 0,      -- fencing token
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workers (region_id, status) WHERE status = 'ready';

CREATE TABLE instances (
  id              text PRIMARY KEY,                  -- ins_01J8...
  org_id          text NOT NULL,
  project_id      text NOT NULL,
  release_id      text NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  worker_id       text NOT NULL REFERENCES workers(id),
  region_id       text NOT NULL,
  zone_id         text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('firecracker','wasm')),
  state           text NOT NULL,                     -- see §7.3
  internal_ip     inet,
  port            int,
  vcpu            numeric NOT NULL,
  memory_mib      int NOT NULL,
  start_reason    text,                              -- request|min_instances|scale_up|deploy|replace
  start_method    text,                              -- cold|snapshot|warm_pool
  start_duration_ms int,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz,
  last_request_at timestamptz,
  stopping_at     timestamptz,
  stopped_at      timestamptz,
  stop_reason     text,
  exit_code       int
);
CREATE INDEX ON instances (release_id) WHERE stopped_at IS NULL;
CREATE INDEX ON instances (worker_id) WHERE stopped_at IS NULL;

CREATE TABLE worker_reservations (                    -- optimistic capacity reservation
  instance_id text PRIMARY KEY,
  worker_id   text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  vcpu        numeric NOT NULL,
  memory_mib  int NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX ON worker_reservations (expires_at);
```

## Domains and certificates

```sql
CREATE TABLE domains (
  id                 text PRIMARY KEY,               -- dom_01J8...
  org_id             text NOT NULL,
  project_id         text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id     text REFERENCES environments(id) ON DELETE CASCADE,
  hostname           citext NOT NULL UNIQUE,
  kind               text NOT NULL
                     CHECK (kind IN ('platform','custom','wildcard')),
  verification_token text,
  verification_method text CHECK (verification_method IN ('dns_txt','http','cname')),
  verified_at        timestamptz,
  certificate_id     text,
  redirect_to        text,
  status             text NOT NULL
                     CHECK (status IN ('pending_verification','verifying','active','error','disabled')),
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE certificates (
  id             text PRIMARY KEY,
  org_id         text,
  hostnames      text[] NOT NULL,
  issuer         text NOT NULL,                      -- letsencrypt | zerossl | custom
  cert_pem       text NOT NULL,
  chain_pem      text NOT NULL,
  key_ciphertext bytea NOT NULL,
  key_nonce      bytea NOT NULL,
  dek_id         text NOT NULL REFERENCES data_keys(id),
  not_before     timestamptz NOT NULL,
  not_after      timestamptz NOT NULL,
  renewal_state  text NOT NULL DEFAULT 'ok',
  last_renewal_error text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON certificates (not_after);
```

## Git, usage, quotas, audit

```sql
CREATE TABLE git_installations (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('github','gitlab','bitbucket')),
  external_id       text NOT NULL,                   -- installation id
  account_login     text NOT NULL,
  access_token_enc  bytea,                           -- for OAuth providers
  refresh_token_enc bytea,
  token_expires_at  timestamptz,
  webhook_secret_enc bytea NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE TABLE usage_records (                          -- append-only, partitioned by month
  id            bigserial,
  org_id        text NOT NULL,
  project_id    text,
  release_id    text,
  instance_id   text,
  region_id     text,
  metric        text NOT NULL,                        -- cpu_ms|mem_mib_ms|requests|egress_bytes|
                                                      -- build_seconds|storage_byte_hours|instance_seconds
  quantity      numeric NOT NULL,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,
  source        text NOT NULL,                        -- agent|gateway|builder
  dedup_key     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, window_start)
) PARTITION BY RANGE (window_start);
CREATE UNIQUE INDEX ON usage_records (dedup_key, window_start);
CREATE INDEX ON usage_records (org_id, window_start);

CREATE TABLE quotas (
  org_id                 text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  max_projects           int NOT NULL DEFAULT 10,
  max_concurrent_builds  int NOT NULL DEFAULT 2,
  max_instances_total    int NOT NULL DEFAULT 20,
  max_instances_per_release int NOT NULL DEFAULT 10,
  max_vcpu_per_instance  numeric NOT NULL DEFAULT 2,
  max_memory_mib         int NOT NULL DEFAULT 2048,
  max_image_size_bytes   bigint NOT NULL DEFAULT 2147483648,
  max_build_minutes_month int NOT NULL DEFAULT 500,
  max_egress_gib_month   int NOT NULL DEFAULT 100,
  max_custom_domains     int NOT NULL DEFAULT 5,
  api_rate_per_min       int NOT NULL DEFAULT 600,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (                             -- append-only, partitioned by month
  id           bigserial,
  org_id       text NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('user','token','system','git')),
  actor_id     text,
  actor_ip     inet,
  user_agent   text,
  action       text NOT NULL,                         -- project.create, secret.update, ...
  resource_type text NOT NULL,
  resource_id  text,
  before       jsonb,
  after        jsonb,
  outcome      text NOT NULL CHECK (outcome IN ('success','failure','denied')),
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ON audit_logs (org_id, created_at DESC);
```

## 15.4 Notes on schema decisions

- **`deployments` vs `releases` are separate.** A deployment is an *attempt*; a release is a *runnable artifact + config*. A failed deployment has no release. A rollback creates a new deployment pointing at an existing release. Conflating them (one `deployments` table that is both) is the most common modeling mistake in this domain and makes rollback, promotion, and history all awkward.
- **`env_snapshot_id` on releases** implements the pinning decision from [§4.5](../04-deployment-pipeline/#45-rollback).
- **`workers.generation`** is a fencing token ([§38.3](../38-distributed-systems-concerns/#383-distributed-locks-leases-and-fencing)): every re-registration increments it, and the control plane rejects reports from a stale generation, which prevents a resurrected zombie worker from claiming instances.
- **`usage_records` partitioned by month with a `dedup_key`** makes at-least-once delivery safe: duplicate events collide on the unique index and are discarded.
- **`instances` is not truncated** — it is the record of what ran where, needed for billing disputes and incident forensics. Partition or archive it monthly; it will be your largest table.
- Consider **TimescaleDB or a separate ClickHouse** for `usage_records` and instance history at <span class="mat mat-scale">SCALE</span>. Start in Postgres.
