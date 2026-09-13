---
title: "9. Universal Runtime Specification"
description: "The runtime definition and helix.yaml schemas that let a new language ship without core changes."
sidebar:
  order: 9
---

## 9.1 The two documents

There is a critical separation that makes "add a language without touching the core" actually work:

| Document | Owned by | Lives in | Purpose |
|---|---|---|---|
| **Runtime Definition** | The platform (or a community contribution) | `runtime-definitions/<name>/<version>.yaml`, versioned and signed | Describes *how to build and run* a language: build image, run image, default commands, detection heuristics, cache paths, health defaults |
| **Project Configuration** (`helix.yaml`) | The user | The user's repository | Selects a runtime and overrides specifics for their app |

Adding Bun = adding one YAML file and two container images to a registry. It requires no code change, no deploy of the control plane, no scheduler change. That is the test of whether the abstraction is right.

## 9.2 Runtime Definition schema

```yaml
# runtime-definitions/java/21.yaml
apiVersion: helix.dev/v1
kind: RuntimeDefinition

metadata:
  name: java
  version: "21"
  aliases: ["java21", "jdk21"]
  display_name: "Java 21 (Temurin)"
  status: ga                 # ga | beta | experimental | deprecated
  deprecated_after: null
  maintainer: "platform-team"

detect:                       # used by `helix init` to autodetect; never at deploy time
  files: ["pom.xml", "build.gradle", "build.gradle.kts"]
  priority: 50

build:
  image: "ghcr.io/helix/build-java@sha256:5f2c..."    # ALWAYS pinned by digest
  default_command: |
    if [ -f mvnw ]; then ./mvnw -B -DskipTests package;
    elif [ -f gradlew ]; then ./gradlew --no-daemon build -x test;
    else mvn -B -DskipTests package; fi
  workdir: /src
  cache_paths:                # become BuildKit cache mounts, scoped per project
    - /root/.m2
    - /root/.gradle
  env:
    JAVA_TOOL_OPTIONS: "-XX:+UseSerialGC -Xshare:auto"
    MAVEN_OPTS: "-Dmaven.repo.local=/root/.m2/repository"
  output:
    # glob(s) copied into the run stage
    artifacts: ["target/*.jar", "build/libs/*.jar"]
    dest: /app

run:
  image: "ghcr.io/helix/run-java@sha256:9b41..."      # JRE only, distroless-ish
  default_command: ["sh","-c","exec java $JAVA_OPTS -jar /app/app.jar"]
  workdir: /app
  user: "65534:65534"
  env:
    JAVA_OPTS: "-XX:MaxRAMPercentage=75 -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:+UseContainerSupport"
  # signals the platform uses for graceful shutdown
  stop_signal: SIGTERM
  stop_grace_period: 30s

defaults:
  http:
    port: 8080
    port_env: PORT            # platform injects PORT; runtime tells us the convention
  resources:
    vcpu: 1
    memory: 512Mi
    ephemeral_storage: 1Gi
  health:
    startup:  { type: tcp, timeout: 90s, initial_delay: 2s }
    readiness: { type: tcp, period: 10s, failures: 3 }
  scaling:
    target_concurrency: 40

capabilities:
  wasm_compatible: false
  supports_snapshot: true
  snapshot_warmup_requests: 3     # hit the health endpoint N times before snapshotting
  architectures: ["amd64", "arm64"]

limits:
  max_build_memory: 8Gi
  max_image_size: 2Gi
```

**Why every field exists:**
- `build.image` / `run.image` pinned **by digest** — a tag-based reference means the platform's behavior changes silently under users, and it is a supply-chain hole.
- `cache_paths` — the platform knows where each ecosystem caches; users should not have to.
- `output.artifacts` — enables a two-stage build without users writing a Dockerfile, which is where most of the image-size win comes from.
- `port_env` — some ecosystems read `PORT`, some need a flag. The definition encodes it.
- `snapshot_warmup_requests` — JVM/`.NET` need warm-up before snapshotting or the snapshot captures a cold JIT.
- `status` / `deprecated_after` — you will need to sunset language versions; design for it now.

## 9.3 Project configuration (`helix.yaml`) — complete schema

```yaml
# helix.yaml — the "vercel.json" of this platform
version: 1                                   # config schema version, required

name: my-api                                  # project name; [a-z0-9-]{1,40}

runtime:
  kind: firecracker                           # firecracker | wasm    (default: firecracker)
  type: java                                  # runtime definition name
  version: "21"                               # resolved against available definitions
  architecture: amd64                         # amd64 | arm64 | auto

build:
  # Mode A: managed runtime (default)
  command: ./mvnw -B -DskipTests package
  output: target/app.jar                      # overrides runtime default artifact glob
  # Mode B: bring your own Dockerfile
  # dockerfile: ./Dockerfile
  # context: .
  # target: production                        # multi-stage target
  # Mode C: prebuilt image (mutually exclusive with the above)
  # image: ghcr.io/me/app@sha256:...
  env:                                        # build-time only, NOT present at runtime
    MAVEN_PROFILE: prod
  secrets: ["NPM_TOKEN"]                      # names of build secrets to mount
  cache: true
  network: allowlist                          # allowlist | none
  extra_hosts: ["internal.npm.mycorp.com"]    # requires approval
  timeout: 20m
  ignore: [".git", "docs/**", "*.md"]

run:
  command: ["java","-jar","/app/app.jar"]     # overrides runtime default
  workdir: /app
  user: "65534:65534"

http:
  port: 8080
  protocol: http1                             # http1 | http2 | h2c
  request_timeout: 30s
  idle_timeout: 60s
  max_request_body: 10Mi
  max_response_body: 100Mi                    # 0 = unlimited (streaming)
  websockets: false
  streaming: true

resources:
  cpu: 1                                      # vCPU, may be fractional: 0.25, 0.5, 1, 2, 4
  memory: 512Mi
  ephemeral_storage: 1Gi

scaling:
  min_instances: 0                            # 0 enables scale-to-zero
  max_instances: 10
  target_concurrency: 50                      # requests in flight per instance
  scale_down_delay: 60s
  # optional secondary signals
  target_cpu_percent: 70
  cold_start_budget: 5s                       # queue this long before returning 503

health:
  startup:
    type: http                                # http | tcp | exec | none
    path: /healthz
    timeout: 60s
    initial_delay: 1s
  readiness:
    type: http
    path: /healthz
    period: 10s
    timeout: 2s
    failure_threshold: 3
  liveness:
    type: http
    path: /healthz
    period: 30s
    failure_threshold: 5                      # restarts the instance

env:                                          # plaintext, per-environment
  LOG_LEVEL: info
  FEATURE_X: "true"

secrets:                                      # names only; values set out-of-band
  - DATABASE_URL
  - STRIPE_SECRET_KEY

environments:                                 # per-environment overrides
  production:
    scaling: { min_instances: 2, max_instances: 50 }
    env: { LOG_LEVEL: warn }
    regions: ["sin1", "fra1"]
  preview:
    scaling: { min_instances: 0, max_instances: 2 }
    resources: { memory: 256Mi }

regions: ["sin1"]                             # default placement

routes:                                       # optional path-based routing / rewrites
  - src: "/api/(.*)"
    dest: "/$1"
  - src: "/old-path"
    redirect: "/new-path"
    status: 308

headers:
  - for: "/static/(.*)"
    set:
      Cache-Control: "public, max-age=31536000, immutable"

lifecycle:
  pre_stop: ["sh","-c","sleep 5"]             # run before SIGTERM, for LB drain
  stop_grace_period: 30s

observability:
  log_format: json                            # json | text
  otel: true                                  # inject OTEL_EXPORTER_OTLP_ENDPOINT

deploy:
  strategy: canary                            # immediate | canary | blue-green
  canary:
    steps: [5, 25, 100]
    interval: 2m
    auto_rollback:
      error_rate_threshold: 0.05
      p95_latency_multiplier: 2.0
```

## 9.4 Improvements over the naive version

The configuration in the original brief was a reasonable start. Changes worth making explicit:

1. **`version: 1` at the top.** You *will* need to evolve this schema. Without a version field, every change is a compatibility crisis.
2. **`runtime.kind` separate from `runtime.type`.** `kind` selects the execution engine (firecracker/wasm); `type` selects the language. Conflating them means `wasm` becomes a fake "language."
3. **`environments` block.** Without it, users maintain three copies of the config or wire up templating. This is the single most-requested feature in every platform of this type.
4. **Health checks split into startup/readiness/liveness.** A single "health" check cannot express "this takes 90 s to boot but should be restarted if it hangs for 30 s later." Conflating them causes crashloops on slow-starting apps — the classic Kubernetes footgun; do not repeat it.
5. **`build.env` and `build.secrets` distinct from runtime `env`/`secrets`.** Different trust contexts ([§5.4](../05-build-system/#54-build-secrets)).
6. **`scaling.cold_start_budget`.** Makes the scale-to-zero latency contract explicit and user-tunable rather than a hidden platform constant.
7. **`deploy.strategy` with auto-rollback thresholds.** Rollback as a first-class config, not a manual operation.
8. **`architecture: auto`.** Lets you introduce arm64 workers and migrate users by cost without breaking anyone.
9. **`build.network: none`** as a first-class option — better security and faster builds, and it gives you something to recommend.
10. **No `regions` at top level only** — regions belong per-environment too, since preview deployments should be cheap and single-region.

## 9.5 Validation

Validation happens in three places, with different jobs:

| Stage | What | Failure behavior |
|---|---|---|
| **CLI (`helix validate`)** | JSON Schema + semantic lint + "did you mean" suggestions | Immediate, local, free |
| **API admission** | Re-validate (never trust the client), plus authorization-aware checks: are these resources within the org's plan? Is this region enabled for you? Does the referenced runtime version exist and is it not deprecated? Are the named secrets defined? | `422` with a structured error list: `[{path: "scaling.max_instances", code: "quota_exceeded", message: "...", limit: 10}]` |
| **Build/run materialization** | Fully resolved spec must satisfy invariants (port in range, command non-empty, image digest present) | Internal error — indicates a platform bug |

**Security implications of the schema — each field is an attack surface:**

| Field | Risk | Control |
|---|---|---|
| `build.command` / `run.command` | Arbitrary code — but that is the product. The risk is *injection into the platform's own shell context* | Never string-interpolate user commands into a host-side shell. Pass as an `argv` array into the guest, or write to a file the guest executes. Template rendering happens into a Dockerfile that BuildKit parses — validate that the command cannot break out of the heredoc/quoting |
| `build.dockerfile` path, `build.context` | Path traversal to read outside the repo | Canonicalize and reject anything outside the checkout root; reject symlinks crossing the boundary |
| `build.image` / prebuilt image | Pulling an arbitrary image | [§10](../10-custom-runtimes/) policy: allowlist or scan+sign requirements |
| `build.extra_hosts` | Egress allowlist bypass → SSRF | Requires review/approval; never allows IP literals, RFC1918, or metadata addresses |
| `resources.*` | Resource exhaustion | Hard plan ceilings, enforced server-side |
| `scaling.max_instances` | Cost/DoS | Plan ceiling; also a global per-org instance cap |
| `env` keys | Overriding platform-injected vars (`PORT`, `HELIX_*`, `LD_PRELOAD`) | **Reserved prefix list**: reject `HELIX_*`; warn on `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH` overrides; platform vars are injected *after* user vars so they win |
| `routes[].src` regex | ReDoS in the router | Use RE2 (no backtracking) for user-supplied patterns, or restrict to a glob subset. **Never** run user regexes on a backtracking engine in the request path |
| `routes[].dest` | Open redirect / SSRF via rewrite | Rewrites are path-only; redirects to external hosts require an explicit allowlist and are flagged |
| `headers[].set` | Header injection, cache poisoning | Reject CR/LF, reject hop-by-hop headers, reject `Host`, forbid overriding platform security headers |
| `health.*.path` | Pointing a probe at an expensive endpoint | Document; rate-limit probes; cap probe frequency |
| `lifecycle.pre_stop` | Indefinite hang blocking drains | Hard cap at `stop_grace_period` |
| YAML itself | Billion-laughs, aliases, arbitrary tags | Parse with a **safe** YAML loader, alias expansion limits, 256 KiB document cap, max nesting depth |

## 9.6 Resolution order

Later wins:

```text
runtime definition defaults
  → project settings stored in the dashboard
    → helix.yaml base
      → helix.yaml environments.<env>
        → deploy-time CLI flags / API overrides
          → platform-injected reserved variables (always last)
```

The **fully resolved** result is hashed and stored in the `ReleaseSpec`. Nothing re-resolves later. This is what makes rollback exact.
