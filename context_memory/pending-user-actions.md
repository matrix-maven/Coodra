# Pending User Actions

Things only the user can do (per `essentialsforclaude/02-agent-human-boundary.md` §2.2). The agent must never fake these. Move resolved items out of this file when the user confirms the action is complete.

Format:

```
## YYYY-MM-DD HH:mm — <short title>
**What is needed:** <concrete artifact — env var name / account / URL>
**Why:** <which module or feature this blocks>
**Steps:** <URL + UI steps the user follows>
**What to paste back:** <exact string the user returns>
**Blocking module:** <N — Name, or "non-blocking for now">
```

---

## 2026-04-22 20:58 — Install Docker Desktop (PERSISTENT — Module 02 + 03 + future testcontainers tests)

**What is needed:** A running Docker daemon on the dev machine.
**Why:** Module 02 already merged with testcontainers-backed Postgres tests (`pgvector/pgvector:pg16`) running in CI; locally the same suite needs Docker. Module 03 inherits this dependency for the cloud-mode-write integration test in S13 + the cross-mode test. Future modules continue to add testcontainers-backed integration tests. CI does not need Docker install because GitHub's `ubuntu-latest` runners ship with a Docker daemon.
**Steps:** Install Docker Desktop for macOS from <https://www.docker.com/products/docker-desktop> and start it. Verify with `docker --version` and `docker info`.
**What to paste back:** Output of `docker --version` (expected format: `Docker version 24.x.x, build ...`).
**Blocking module:** None blocking right now (Module 02 + 03 unit/CI suites pass without local Docker — only the local integration test command needs it).

## ✅ 2026-05-03 — Clerk dev project supplied (originally 2026-04-22 ask)

**Resolved:** User supplied Clerk dev keys 2026-04-24 (already in `.env`); reconfirmed 2026-05-03 with explicit "I will replace the key when I am done with the testing" — these are throwaway dev creds.

**Stored at:** `Coodra/.env` — `CLERK_PUBLISHABLE_KEY=pk_test_ZnVuLWdudS05Ni5jbGVyay5hY2NvdW50cy5kZXYk` + `CLERK_SECRET_KEY=sk_test_n5ifOCG...`. Tenant slug: `fun-gnu-96`.

**Still pending:** `CLERK_JWT_ISSUER` URL is not yet paste-confirmed (typically `https://clerk.fun-gnu-96.accounts.dev` based on the publishable key's encoded value). M04 S1 needs to confirm by hitting Clerk's `.well-known/jwks.json` endpoint and updating `apps/mcp-server/src/lib/auth.ts` env schema.

**Blocking module:** M04 S1 (web app sign-in flow + JWT validation against this tenant). Originally blocked on supplying keys; now blocked only on the live-tenant smoke test as part of S1 acceptance.

## 2026-04-24 10:45 — `LOCAL_HOOK_SECRET` config-file reads via a future `coodra team login` CLI

**What is needed:** A dedicated CLI command (`coodra team login`) that writes `~/.coodra/config.json` with the team-mode secret, per `system-architecture.md` §19's spec. Tracking this here because S7b's `lib/auth.ts::verifyLocalHookSecret` currently reads the secret from the `LOCAL_HOOK_SECRET` env var only.
**Why:** §19 says the shared secret belongs in `~/.coodra/config.json`, not in a process env var. Module 02 S7b scoped this intentionally to env-only (decisions-log 2026-04-24 — user S7b directive Q7). The follow-up is a dedicated module (Module 07 VS Code Extension, or a dedicated distribution module) that ships the CLI; until then, team-mode operators set the env var manually and the env schema validates `≥16 chars`.
**Steps:** No user action today. This entry exists so the follow-up is not forgotten when Module 07 opens.
**What to paste back:** Nothing now. When the CLI module ships, the `lib/auth.ts::verifyLocalHookSecret` integration will switch to reading `~/.coodra/config.json` first, env var second.
**Blocking module:** None for Module 02. Follow-up for Module 07 / dedicated distribution module.

## 🟡 2026-04-24 14:00 — Provision team-mode hosted infra before team deploy (we host, no BYO) — partially resolved 2026-05-03

**What is needed:** Supabase Postgres project (pgvector extension enabled), Upstash Redis database, Railway OR Fly.io account, Clerk production project. **One stack per environment**, owned by you (the project lead). Per directive 2026-04-24 the team service is hosted by us — there is no BYO-cloud variant in v1.

**Status:**
  1. ✅ Supabase: provisioned at `gyopozvfmggumidptmjr.supabase.co` (2026-05-03). DATABASE_URL in `.env`. `vector` extension available; will install on first Drizzle migrate. (Was previously `picihoywjtnaxbhbfgaj` — replaced.)
  2. ❌ Upstash Redis: not yet provisioned. Required for team-mode BullMQ jobs (sync-daemon dispatch, NL Assembly enrichment, semantic-diff).
  3. ❌ Railway/Fly.io: not yet picked. M04 S0 OQ-8 needs the user to lock the deploy target.
  4. ✅ Clerk dev project: supplied 2026-04-24, reconfirmed 2026-05-03. Production project still TBD before any prod cutover.
  5. ❌ `.env.production`: not yet created. Solo dev path uses `.env` directly.

**Blocking module:** Items 2–5 block team-mode cloud deploy (post-M04). Items 1 + 4 unblock M04 S1 (web app boots against Supabase + Clerk).

## 2026-04-24 14:00 — `GEMINI_API_KEY` before Module 05 (Anthropic NOT required)

**What is needed:** `GEMINI_API_KEY` from Google AI Studio.
**Why:** Per directive 2026-04-24 the managed LLM path is Gemini, not Anthropic. Solo mode continues to support Ollama (local, no key needed). Team mode's NL Assembly Tier-2 calls Gemini with our key.
**Steps:** Create a key at <https://aistudio.google.com/app/apikey>. Free tier is sufficient for early dev. Paste into `.env` locally as `GEMINI_API_KEY=...`.
**What to paste back:** Confirmation that `GEMINI_API_KEY` is populated (do NOT paste the key itself).
**Blocking module:** Module 05 (NL Assembly) Tier-2 in team mode. Solo mode unaffected.

## 2026-04-24 14:00 — GitHub App registration — concrete steps (DUE before §23 integration module)

**What is needed:** A GitHub App registered on github.com, installed on at least one test repository, with: App ID, App slug, webhook secret, OAuth client ID, OAuth client secret, and the App's private-key PEM downloaded.

**Why:** All 10 GitHub MCP tools in `system-architecture.md` §23 authenticate as a GitHub App (App-level webhooks + per-installation tokens). Without this you cannot test PR/branch-protection/CODEOWNERS flows end-to-end.

**Concrete step-by-step (the exact answer to "what should I do"):**

1. **Decide the scope.** For your dev work: register the App under your **personal account** at <https://github.com/settings/apps> → "New GitHub App". For an org you manage: <https://github.com/organizations/{org}/settings/apps> → "New GitHub App".
2. **Fill the App form:**
   - **GitHub App name:** `Coodra Local Dev` (must be globally unique on github.com — append a suffix if taken).
   - **Homepage URL:** `https://github.com/Abishai95141/Coodra` (or any valid URL — required field, not validated for the App's function).
   - **Callback URL:** `http://localhost:3101/v1/oauth/github/callback` (Module 03's Hooks Bridge will own this route; it doesn't have to exist yet for App creation).
   - **Webhook URL:** for local dev you have two paths:
     - **Path A (recommended):** install **smee.io** as a webhook proxy: visit <https://smee.io/new>, copy the URL it generates, paste into the GitHub App's Webhook URL. Locally: `npx smee-client --url <smee-url> --target http://localhost:3101/v1/webhooks/github`.
     - **Path B:** use **cloudflared** or **ngrok** to expose your localhost. Equivalent UX, slightly heavier setup.
   - **Webhook secret:** generate a random 64-char hex string with `openssl rand -hex 32` and paste it. **Save this string** — GitHub does NOT show it again after the App is created.
3. **Set repository permissions** (the granular ones the §23 tools use):
   - Contents: **Read**
   - Pull requests: **Read & Write** (Write is needed to post PR comments — required for the `github_post_pr_comment` tool)
   - Issues: **Read**
   - Metadata: **Read** (auto-selected, can't be turned off)
   - Checks: **Read**
   - Administration: **Read** (for branch-protection introspection — §23.3 / §23.4)
4. **Set organization permissions** (only relevant if you registered the App under an org):
   - Members: **Read** (for resolving CODEOWNERS user/team handles to identities)
5. **Subscribe to events:**
   - `Pull request`
   - `Pull request review`
   - `Pull request review comment`
   - `Push`
   - `Issues`
   - `Issue comment`
   - `Branch protection rule`
   - `Repository`
6. **Where can this GitHub App be installed?**
   - For dev work: **"Only on this account"**.
   - For production multi-tenant team mode: **"Any account"** (lets paying customers install on their orgs). You will likely register **two separate Apps** — one dev (`Coodra Local Dev`, "Only on this account"), one production (`Coodra`, "Any account"). Don't reuse one App for both — leaks dev webhooks into prod.
7. **Click "Create GitHub App."**
8. **Generate a private key** on the App's settings page → "Private keys" → "Generate a private key". A `.pem` file downloads. **Store this securely** — GitHub does NOT keep a copy.
9. **Note the App ID** (top of the App settings page, e.g. `1234567`) and the **App slug** (the URL slug GitHub assigned, e.g. `coodra-local-dev`).
10. **Install the App** on at least one test repo: App settings page → "Install App" sidebar → choose your account → select repos. After install, note the **Installation ID** (visible in the URL after install: `https://github.com/settings/installations/<id>`, or via the GitHub API).
11. **Add to `.env` locally** (never committed):
    ```
    GITHUB_APP_ID=<the numeric App ID>
    GITHUB_APP_SLUG=<the URL slug>
    GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"   # single-line, \n-escaped
    GITHUB_APP_WEBHOOK_SECRET=<the openssl rand -hex 32 string from step 2>
    GITHUB_APP_INSTALLATION_ID=<the installation ID from step 10>
    GITHUB_APP_CLIENT_ID=<from App settings — only needed for the user-OAuth flow, optional in dev>
    GITHUB_APP_CLIENT_SECRET=<from App settings — generate via "Generate a new client secret">
    ```
**What to paste back:** Confirmation that all six required env vars (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_INSTALLATION_ID`, plus the smee.io URL if using Path A) are populated. Do NOT paste secrets themselves.

**Blocking module:** Post-Module-02 / post-Module-03 GitHub integration module. Module 02 explicitly does NOT ship JIRA/GitHub tools per directive Step 2 non-goals; those land in a dedicated integration module after Module 03 merges (because the webhook-receive surface lives in the Hooks Bridge).

## 2026-04-22 14:27 — Atlassian OAuth 2.0 (3LO) app registration before §22 JIRA tools ship (deferred)

**What is needed:** An Atlassian Cloud Developer Console app with OAuth 2.0 (3LO) enabled, client ID, client secret, and a registered webhook.
**Why:** All 8 JIRA MCP tools in `system-architecture.md` §22 authenticate via 3LO.
**Steps:** Register at <https://developer.atlassian.com/console/myapps/>, enable Jira Cloud Platform scopes, set callback URL (Module-03 Hooks Bridge URL), generate a webhook secret. **Lower priority than the GitHub App** — JIRA integration is optional in v1; users can adopt Coodra without ever connecting JIRA.
**What to paste back:** `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `ATLASSIAN_WEBHOOK_SECRET` populated in `.env`.
**Blocking module:** Post-Module-02 JIRA integration module (lower priority than the GitHub App).

## 2026-04-24 14:00 — npm scope claim for `@coodra` before Module 08a publish

**What is needed:** Reserve the `@coodra` npm scope (or pick an alternative scope if taken).
**Why:** Module 08a's CLI is `@coodra/cli`. The scope must be claimed before the publish-flag-day at the end of 08a.
**Steps:** Visit <https://www.npmjs.com/signup>, sign in (or create an org), then create the `@coodra` org at <https://www.npmjs.com/org/create>. If `@coodra` is taken, pick `@coodra` or another available scope and update the workspace package names in the same commit.
**What to paste back:** Confirmation of the scope claimed (just the name).
**Blocking module:** Module 08a S9 publish-flag-day (the package builds and runs without the scope; only `npm publish` requires it).

## 2026-04-24 14:00 — Anthropic MCP marketplace listing (post-08a)

**What is needed:** Submission of `@coodra/cli` to the Anthropic MCP marketplace (when the marketplace opens to third-party submissions).
**Why:** Discovery channel — Claude Code users will browse the marketplace before they search npm.
**Steps:** Watch <https://docs.anthropic.com/> for the marketplace submission portal launch. When live, follow the submission steps with `@coodra/cli` as the package name. No action required from you today.
**What to paste back:** Submission confirmation when the marketplace accepts the listing.
**Blocking module:** None (post-launch ops, not on the critical path).

## ✅ 2026-04-27 11:25 — Module 03.1 (Durable Audit Outbox) shipped before M04 (resolved)

**Resolved:** M03.1 landed (README module-status table shows ✅; `pending_jobs` substrate active in both SQLite + Postgres). M04 can start with audit-trail durability already in place. Original entry preserved below for context.

---

**Original ask:** A scheduling decision — Module 03.1 (Durable Audit Outbox) lands BEFORE Module 04 (Web App).
**Why:** Today every audit row written by the bridge and by MCP `check_policy` is dispatched via `setImmediate(...)` after the HTTP response returns. The dispatch is in-process and not durable — SIGTERM mid-PreToolUse, kill -9, OOM, or deploy restart between response and audit-write loses the row. This was tolerable through M01–M03 because policy decisions are advisory and idempotency keys protect retries, but Module 04's audit-trail UI is the first read surface that surfaces "every decision in this run" — missing rows show up as gaps in the timeline. SOC2 readiness assumes the audit log is complete, not best-effort. F14 fixed audit-trail integrity at the key-shape layer; F8 fixed it at the FK layer; this module fixes it at the durability layer.
**Design seed:** the `pending_jobs` table already exists in both SQLite and Postgres schemas (since M01) as the transactional outbox seed. No schema change required; the worker is the only new code.
**Steps:** confirm scheduling — Module 03.1 lands BEFORE Module 04. The full spec will be written when scheduled; placeholder is at `docs/feature-packs/03.1-durable-outbox/`.
**What to paste back:** "schedule 03.1 before 04" (or "land 04 first and queue 03.1 after if you decide the gap is tolerable for v1").
**Blocking module:** Module 04 (Web App). Landing 04 first locks in audit-trail UI contracts that this module is meant to fix.
