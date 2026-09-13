---
title: "17. Git Integration and Preview Deployments"
description: "GitHub Apps, webhooks, deployment triggers, preview URLs, secrets on forks, and promotion."
sidebar:
  order: 17
---

## 17.1 Provider integration model

| Provider | Mechanism | Notes |
|---|---|---|
| **GitHub** | **GitHub App** (not OAuth App) | Fine-grained per-repo permissions, short-lived installation tokens, Checks API, no user-token expiry problems. This is the right choice |
| **GitLab** | OAuth app + project/group webhooks, or a GitLab App where available | Self-managed GitLab must be supported for enterprise — allow a custom base URL |
| **Bitbucket** | OAuth consumer + webhooks | Lowest priority |

**Permissions requested (GitHub App), minimal:**
`contents: read`, `metadata: read`, `pull_requests: write` (for preview comments), `checks: write` (for status), `deployments: write` (optional, for the Deployments API). **Never** request `contents: write` or admin scopes — you do not need to push, and asking for it loses you enterprise deals.

## 17.2 OAuth and installation flow

<figure class="mermaid-figure"><pre class="mermaid">sequenceDiagram
    participant U as User (browser)
    participant H as Helix
    participant G as GitHub
    U-&gt;&gt;H: &quot;Connect GitHub&quot;
    H-&gt;&gt;U: redirect to GitHub App install URL (state=nonce, bound to session)
    U-&gt;&gt;G: choose org + repositories
    G-&gt;&gt;H: callback /v1/git/github/callback?installation_id=..&amp;state=..
    H-&gt;&gt;H: verify state, bind installation to org
    H-&gt;&gt;G: POST /app/installations/{id}/access_tokens (JWT signed with app key)
    G--&gt;&gt;H: installation token (1h)
    H-&gt;&gt;G: list accessible repos
    H--&gt;&gt;U: repo picker</pre></figure>

App private key lives in KMS; installation tokens are minted per operation and never persisted.

## 17.3 Webhooks

- Endpoint `POST /v1/git/{provider}/webhook`, verified by HMAC (`X-Hub-Signature-256`) with **constant-time comparison**, timestamp freshness, and a replay cache on delivery ID.
- Handled events: `push`, `pull_request` (opened/synchronize/reopened/closed), `installation`/`installation_repositories`, `delete` (branch deleted).
- **Respond 200 within 1 second**, always. Enqueue the work; never process inline. Providers disable webhooks that time out.
- Missed webhooks happen. A reconciliation job polls each connected repo's default branch every 15 minutes and creates a deployment if the head commit has no deployment. This single job removes an entire class of "my deploy didn't trigger" tickets.

## 17.4 Deployment triggers

| Event | Behavior |
|---|---|
| Push to `production_branch` | Deploy to production (if `auto_deploy`) |
| Push to any other branch | Deploy to a branch preview environment (if `preview_enabled`) |
| PR opened / synchronized | Deploy to a PR preview environment; comment with URL |
| PR closed / merged | Schedule preview environment teardown |
| Branch deleted | Tear down its preview environment |
| Tag pushed matching a pattern | Optional: deploy to production (a common enterprise preference over branch-based) |
| Commit message contains `[skip deploy]` | Skip |
| Changed paths do not intersect `root_directory` | Skip (monorepo support — essential, not optional) |

**Superseding:** a new push to a branch with an in-flight deployment for the same branch **cancels** the in-flight one (unless it is already past `BUILT` and deploying to production, where you may prefer to let it finish). This saves enormous build capacity on active branches.

## 17.5 Commit status and checks

Post a GitHub Check Run: `queued` → `in_progress` → `success`/`failure`, with a summary containing build duration, image size, cold-start estimate, vulnerability delta versus the base branch, and the preview URL. Deep-link to logs. This is the highest-visibility surface you have; invest in it.

Also post a single, *updated-in-place* PR comment (never a new comment per push — that is the most-complained-about behavior in this product category).

## 17.6 Preview deployments

```text
PR #42 on acme/my-api, branch feature/new-checkout
   ↓
environment: preview (kind=preview, git_ref=feature/new-checkout, expires_at=+7d)
   ↓
URLs:
   https://my-api-pr-42-acme.helix.app            ← stable per PR
   https://my-api-9f2c1d0-acme.helix.app          ← immutable per deployment
   https://feature-new-checkout.my-api.acme.dev   ← optional custom preview domain
```

**URL design.** Three levels, all useful:
- *Deployment URL* — includes the short commit SHA, never changes, always points to that exact build. Essential for "the bug was in this build."
- *Branch/PR alias* — moves with the latest deployment on that branch. This is what goes in the PR comment.
- *Custom preview wildcard* — for customers who want previews on their own domain (`*.preview.acme.com` with a delegated wildcard cert).

Slugs must be sanitized: lowercase, `[a-z0-9-]`, truncated with a hash suffix to stay within DNS label limits (63 chars) and to avoid collisions from truncation (`feature/very-long-name-a` and `-b`).

**Environment variables for previews:** a separate `preview` scope. Never expose production secrets to preview deployments by default — a PR from a fork would otherwise leak your production database URL to anyone who opens a PR. **Deployments from forked repositories must run with no secrets at all unless a maintainer explicitly approves**, exactly as GitHub Actions does. This is a real, exploited attack class.

**Access control:** previews can be public (default), password-protected, or restricted to org members via an auth check at the gateway. Offer all three; default to public only if the project's repo is public, otherwise default to protected.

**Cleanup:**
- PR closed → teardown after a grace period (1h, so someone can still look at it).
- Branch preview idle → scale to zero immediately (it should be `min_instances: 0` always), and delete the environment after `expires_at` (default 7 days of no deploys).
- A nightly job reconciles: any preview environment whose branch/PR no longer exists gets torn down.
- Deleting an environment removes routes, certs, and instances; images are GC'd on the normal schedule.

**Production promotion:** `helix promote <deployment-id>` takes the *exact image* from a preview deployment and creates a production release from it, re-resolving only the environment-specific config (env vars, scaling, regions). No rebuild. This makes "what I tested is what ships" literally true, which is the main value proposition of previews.
