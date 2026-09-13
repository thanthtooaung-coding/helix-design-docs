---
title: "26. Developer Experience and CLI"
description: "CLI design goals, the command surface, its architecture, and what a good error message looks like."
sidebar:
  order: 26
---

## 26.1 Design goals

1. **Time from `git clone` of an example to a live URL: under 3 minutes**, including signup.
2. **Every error tells you what to do next.** Not "deployment failed" but "your app is listening on 127.0.0.1:8080; bind to 0.0.0.0:$PORT instead — see https://docs.helix.dev/port".
3. **The CLI is a first-class client of the public API.** No private endpoints. If the CLI can do it, a customer's script can.
4. **Works offline for everything that does not need the server** (`init`, `validate`, `config`).

## 26.2 Command surface

```bash
# Auth
helix login                          # device-code OAuth flow, opens browser, stores token in OS keyring
helix logout
helix whoami
helix org list | switch <slug>

# Project lifecycle
helix init                           # detect runtime, generate helix.yaml interactively
helix link                           # link this directory to an existing project
helix validate                       # local schema + semantic validation
helix deploy [--env production] [--prod] [--no-wait] [--message "..."]
helix dev                            # run locally in a container matching the runtime image

# Inspect
helix status                         # current release, instances, health, recent deploys
helix deployments list [--env] [--limit 20]
helix deployments inspect <id>
helix logs [--env production] [--follow] [--since 1h] [--instance <id>] [--filter "level=error"]
helix logs --build <deployment-id>
helix metrics [--metric p95] [--since 24h]
helix usage [--from 2026-09-01]

# Change
helix rollback [<deployment-id>]     # defaults to the previous successful release
helix promote <deployment-id>        # preview → production, same image
helix redeploy                       # rebuild current commit
helix cancel <deployment-id>
helix scale --min 1 --max 20 --concurrency 40
helix restart

# Config
helix env list|set|rm|pull|push      # plaintext vars; pull writes .env.local
helix secrets list|set|rm            # values write-only; list shows keys+metadata
helix domains list|add|remove|verify
helix regions list|add|remove

# Runtimes & debugging
helix runtimes list
helix run <cmd>                      # one-off task in a fresh instance of the current release
helix shell                          # interactive shell in a NEW instance (never a production one)
helix doctor                         # diagnose local setup + project config issues
helix open                           # open the deployment URL in a browser
```

**Two deliberate DX decisions:**

- `helix shell` starts a **new** instance from the same release rather than attaching to a serving instance. Attaching to production would be convenient and is what people ask for, but it breaks the immutability model, creates a debugging-vs-serving resource conflict, and is an audit nightmare. Offer it as `--attach` behind a permission and an audit event if demand is overwhelming.
- `helix dev` runs the app locally in the *same run image* the platform uses, with the same env vars. "Works locally, breaks on deploy" is the most corrosive DX failure, and matching the image removes most of its causes.

## 26.3 CLI architecture

```text
cli/
├── cmd/            Cobra command tree; thin — parse, call, render
├── internal/
│   ├── api/        Generated client from the OpenAPI spec (single source of truth)
│   ├── auth/       Device-code flow, OS keyring (keychain/wincred/secret-service),
│   │               token refresh, org context
│   ├── config/     helix.yaml parse + validate (shared crate/module with the server
│   │               so validation is IDENTICAL locally and remotely)
│   ├── project/    Link file (.helix/project.json), runtime detection heuristics
│   ├── upload/     Tarball creation honoring .helixignore, presigned upload, resumable
│   ├── stream/     SSE/WebSocket log tailing with reconnect and sequence-based dedup
│   ├── render/     Human output (tables, spinners, colors) and --json for scripts
│   └── update/     Self-update with signature verification
└── main.go
```

Key choices:
- **Go**, single static binary, cross-compiled for linux/darwin/windows × amd64/arm64. Distributed via Homebrew, Scoop, `curl | sh` (with a checksum and a signature), and a Docker image.
- **The config validation code is shared with the server** — compiled into both. This is worth the coupling: divergent validation between CLI and API is a constant source of "it validated locally but failed on deploy."
- **`--json` on every command** and stable exit codes, so the CLI is usable in CI without screen-scraping.
- **Never store tokens in a plaintext dotfile** when an OS keyring is available; fall back to a `0600` file with a warning.
- Telemetry is opt-in, anonymous, and disclosed.

## 26.4 Other DX surfaces

| Surface | Notes |
|---|---|
| **Dashboard** | Next.js/React SPA. Deployment timeline, live build logs, runtime logs with filtering, metrics, env/secrets, domains, usage. The deployment detail page is the most-viewed screen in the product — make the failure states excellent |
| **GitHub Checks + PR comment** | [§17.5](../17-git-integration-and-preview-deployments/#175-commit-status-and-checks) |
| **SDKs** | Generated from OpenAPI for TS, Go, Python. Low effort, high perceived quality |
| **GitHub Action / GitLab template** | `helix/deploy-action@v1` with OIDC auth |
| **Terraform provider** | Enterprise requirement; defer to [V1+] |
| **Docs** | Runtime-specific quickstarts that actually work, copy-pasteable. A troubleshooting page for each common failure (port binding, missing lockfile, OOM, slow cold start, health check) |
| **Example repos** | One per runtime, deployable with one click. These are your most effective marketing and your best integration tests |

## 26.5 Error message quality (a worked example)

This is a product feature, so specify it:

```text
✗ Deployment failed: application did not become healthy

  Your app started but the startup probe never succeeded within 60s.

  What we observed:
    • Process started (pid 1) at 04:16:44
    • Process is running and has not exited
    • Port 8080 has no listener inside the instance
    • Last 5 log lines:
        2026-09-13T04:16:45Z  Started MyApp in 1.204 seconds
        2026-09-13T04:16:45Z  Tomcat started on port 8080 (http) with context path ''
        2026-09-13T04:16:45Z  Listening on 127.0.0.1:8080

  Most likely cause:
    Your app is bound to 127.0.0.1, which is only reachable from inside
    the instance. The platform connects from outside the guest.

  Fix:
    server.address=0.0.0.0        (application.properties)
    or set SERVER_ADDRESS=0.0.0.0

  Docs: https://docs.helix.dev/troubleshooting/port-binding
  Deployment: https://app.helix.dev/d/dep_01J8Y...
```

Building the detection for each of the top ~15 failure modes (loopback binding, wrong port, missing interpreter, OOM during startup, exited immediately with code N, health path 404, image too large, no lockfile, architecture mismatch) is maybe two weeks of work and will halve your support load.
