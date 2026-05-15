# Team Mode — Operating Manual

> One document. The mental model, every role's daily flow, every feature
> mapped to either a Web URL or a CLI command, and an honest gap analysis
> of what still needs work. Read once, refer back when stuck.

---

## 0. The mental model in one paragraph

Team mode is **a shared, append-only audit history of every AI coding agent
session your team has ever run, plus the policy chain that governs them, plus
the feature library that describes what you build with**. Every member's
laptop has its own SQLite primary store. A sync daemon mirrors writes to a
single Postgres you own (Supabase recommended) and pulls the other members'
writes back every 10 seconds. Every row carries the Clerk `user_id` of the
person whose agent wrote it, so the UI can answer "who decided what" without
guesswork. Three roles — **admin / member / viewer** — gate who can write
which surface.

The point of all this is that **the next session your teammate starts
already knows what your last session decided**. No more silent contradictions,
no more "wait, who chose Postgres over MySQL again?", no more onboarding
pain when a new engineer joins.

---

## 1. The two workspaces, side by side

You always know which mode you're in because the web UI looks different.

| | **Solo workspace** | **Team workspace** |
|---|---|---|
| Sidebar header | grey "Solo workspace" / "This machine" / `~/.coodra/data.db · click to upgrade` | accent-green "● Team workspace" / your org slug / `syncing every 10 s · click for members` |
| Dashboard eyebrow | `/00 · SOLO WORKSPACE` | `/00 · TEAM WORKSPACE · YOUR-ORG` |
| Dashboard headline | "Your **local** context." | "Your **team's** context." |
| Dashboard lede | "Recorded on this machine. Local-first SQLite, no cloud, no sign-in." | "From every member of your org — mirrored to your Postgres, attributed to who wrote it, queryable by every teammate's next agent session." |
| Sidebar groups | Workspace · Audit · Govern · Knowledge · System · **Upgrade** (CTA to switch) | Workspace · **Team** (members + org · sync queue) · Audit · Govern · Knowledge · System |
| `/settings/team` | **404** (intentional — no team to manage) | full org info + member list |
| Sync queue link | hidden (no outbox to drain) | visible (it's the sync heartbeat) |
| Mode-switch link | "Switch to team" CTA in sidebar Upgrade group | "Mode picker" link in System group |
| Storage | `~/.coodra/data.db` (SQLite, primary) | local SQLite primary + your Supabase Postgres (mirror) |
| Sign-in | none | Clerk JWT (your project) |
| Cost to Coodra | $0 | $0 |
| Cost to you | $0 | whatever Supabase + Clerk charge for the resources you use |

The bridge, MCP server, and sync daemon ship with both modes. **Only the
sync daemon is gated** — it skips boot in solo mode because there's no
`DATABASE_URL` to push to.

---

## 2. The three roles, in one table

| Action | **viewer** | **member** (default) | **admin** |
|---|---|---|---|
| Sign in to web app | ✓ | ✓ | ✓ |
| Browse decisions / packs / runs | ✓ | ✓ | ✓ |
| Run agent sessions (record decisions, save context packs) | ✗ | ✓ | ✓ |
| Author / edit features | ✗ | ✓ on own features | ✓ on any |
| Pause / resume kill-switch on **own** session | ✗ | ✓ | ✓ |
| Pause / resume kill-switch on **anyone's** session | ✗ | ✗ | ✓ |
| Edit policy rules | ✗ | ✗ | ✓ |
| Invite teammates | ✗ | ✗ | ✓ |
| Rotate hook secret | ✗ | ✗ | ✓ |

**Mapping to Clerk:** `org:admin` → admin. `org:viewer` (custom Clerk role
you create) → viewer. Anything else (Clerk default `org:basic_member`)
→ member. The enforcement primitives — `requireRole`, `assertCanEdit`,
`assertCanResumeKillSwitch` — live in `packages/shared/src/auth/roles.ts`.

---

## 3. The unified data layer in one diagram

```
┌──────────────────────────┐     ┌──────────────────────────┐
│   Admin's machine        │     │   Member's machine        │
│  ┌──────────────────┐    │     │  ┌──────────────────┐     │
│  │  Local SQLite    │ ←┐ │     │  │  Local SQLite    │ ←┐  │
│  │  ~/.coodra/   │  │ │     │  │  ~/.coodra/   │  │  │
│  │  data.db         │  │ │     │  │  data.db         │  │  │
│  └─────┬────────────┘  │ │     │  └─────┬────────────┘  │  │
│        │ writes        │ │     │        │ writes        │  │
│        │ (sub-ms)      │ │     │        │ (sub-ms)      │  │
│        ▼               │ │     │        ▼               │  │
│   pending_jobs   ──────┼─┼─────┼───→ pending_jobs ──────┼──┼─→
│   (local outbox)       │ │     │   (local outbox)       │  │
│        │               │ │     │        │               │  │
│   sync-daemon          │ │     │   sync-daemon          │  │
│   pushes every job     │ │     │   pushes every job     │  │
│        │               │ │     │        │               │  │
└────────┼───────────────┘ │     └────────┼───────────────┘  │
         │                 └ pulls ──────────────────────────┘
         ▼                                ▼
   ┌─────────────────────────────────────────────────────┐
   │   YOUR cloud Postgres (Supabase)                    │
   │   12 audit tables + 2 migration metadata tables     │
   │   Every row carries: org_id + created_by_user_id    │
   └─────────────────────────────────────────────────────┘
```

**What flows where, on what cadence:**

| Direction | What syncs | Cadence | Who triggers |
|---|---|---|---|
| Local → Cloud | runs, run_events, decisions, context_packs, policies, policy_decisions, feature_packs (metadata only — see §4), kill_switches, projects | Within ~1 s of local write | Sync daemon's outbox drainer |
| Cloud → Local | Same tables, everyone else's rows | Every 10 s | Sync daemon's `team-rows-puller` |
| Local-only | `pending_jobs` (the outbox itself) | — | Per-machine, never syncs |

**Append-only contract (ADR-007):** none of the above tables ever UPDATE
or DELETE. Idempotency keys collapse retries. This means cloud is an
ever-growing tape; you never lose history.

---

## 4. The feature library — what feature packs actually are

> **This is where I had it wrong before — let me correct it.**

A **feature** is a self-contained skill the agent can load on demand. Each
feature is a directory under `<repo>/docs/features/<slug>/` containing:

- One mandatory `feature.md` with YAML frontmatter (name, description,
  whenNotToUse, maturity, owners, tags) and a markdown body.
- **Any number of supporting files** — code samples, ADRs, sequence
  diagrams, JSON schemas, additional `.md` documents. The directory is
  the unit, not the file.

The pattern is **directly modeled on Anthropic skills**. Agents read a cheap
INDEX (slug + name + description, ~ a few hundred bytes per feature) at
SessionStart, then call `coodra__get_feature(slug)` to load one
feature's full body when a relevant prompt arrives. They call
`coodra__get_feature_file(slug, path)` for supporting files on demand.
The agent never has to read every byte the team has written; it loads what
it needs, when it needs it.

```
docs/features/
  stripe-payments/
    feature.md             ← frontmatter + body (mandatory)
    webhook-flow.md        ← supporting (optional)
    test-cards.json        ← supporting (optional)
    diagrams/
      sequence.png         ← supporting (optional)
  auth-clerk-oauth/
    feature.md
    role-mapping.md
  email-onboarding/
    feature.md
```

The frontmatter `description` field is **load-bearing**:

```yaml
---
name: stripe-payments
description: |
  Use this when implementing Stripe checkout, webhooks, customer subscriptions,
  payment-method management, or refund flows. Covers the coodra-stripe wrapper
  that lives in apps/payments/lib/stripe/.
whenNotToUse: |
  Don't use for non-Stripe payment paths (PayPal lives under `paypal-payments`).
  Don't use for billing-cycle accounting (see `subscription-ledger`).
maturity: stable
owners: [alice@example.com, bob@example.com]
tags: [payments, billing, stripe]
---
```

The agent sees the description-only INDEX at session start. The bridge
fetches the full body via `get_feature` only when the agent's planner
decides this feature is relevant. That keeps cold-start cheap and lets a
team grow to hundreds of features without bloat.

### How features get authored

| Where | What | Who |
|---|---|---|
| **Web `/packs/new`** (becomes `/features/new` after the rename) | Form-based authoring with frontmatter validation, body editor, supporting-file uploads. Saves to `docs/features/<slug>/` on disk + enqueues sync | admin (canonical) / member (own) |
| **Web `/packs/<slug>`** (will become `/features/<slug>`) | Edit existing feature, regenerate frontmatter, attach supporting files | same |
| **CLI `coodra feature add <slug>`** | Scaffold a new feature directory + boilerplate `feature.md` from the terminal | same |
| **Direct edit** | Open the feature directory in your editor, edit any `.md`. The bridge regenerates the INDEX on its stale-mtime check | same |

### How features get distributed (the honest gap)

**Today:** the `feature_packs` cloud table syncs the **metadata** (slug,
checksum, is_active, updated_at, created_by_user_id). The actual file
content travels via **git** — your team's repo. Members run `git pull`,
the new feature dir lands on disk, the bridge picks it up next time it
regenerates the INDEX.

**Why it works:** every team using Coodra already has a git repo for
their code. Putting features under version control next to the code is
the right place for them — they describe the code.

**The gap:** there's no Supabase Storage bucket or DB-blob column for
feature content yet. If a teammate forgets to `git pull` they don't get
the new feature even though their cloud-backed metadata says it exists.

**The fix (next slice):** persist `feature.md` + supporting files into a
`feature_files` table or a Supabase Storage bucket scoped to the org. The
puller pulls files lazily on first access via the `get_feature` /
`get_feature_file` MCP tools. No more git-pull dependency. Not yet shipped.

### What `init` writes today (and the legacy 3-file scaffold)

`coodra init` still scaffolds the old-style 3-file pack
(`docs/feature-packs/<project-slug>/{spec,implementation,techstack}.md`).
That's a vestige of M01 before the skill-style features layer landed. The
`feature_packs` cloud table covers both — it tracks any directory under
either `docs/features/` or `docs/feature-packs/`. The skill-style layer
(`docs/features/<slug>/feature.md`) is the canonical going forward; the
3-file layout is for projects that haven't migrated yet.

---

## 5. Invite security — the redesign

> **You were right that the current flow is shaky. Here's the analysis
> and what I propose.**

### What ships today

```
admin runs `team setup`
  → CLI generates one 32-byte hex hook secret
  → CLI prints (DB URL, org id, secret) once at stdout
  → admin manually copies into 1Password
  → admin manually shares the bundle with each new teammate
  → teammate pastes into `team join --secret <hex>`
```

### Why this is shaky

1. **One org-wide secret.** Anyone with the secret can write to your team
   Postgres. There's no per-teammate scoping.
2. **No revocation.** A teammate leaves → you must rotate the secret →
   every other teammate has to re-run `team join` with the new value.
3. **No expiry.** The secret never times out. A teammate's stale 1Password
   entry on a lost laptop is a write credential to your team DB forever.
4. **Plaintext at rest.** The CLI prints it once and trusts the operator
   to handle it. Most operators paste into Slack DM.
5. **Not actually used as auth on writes.** The secret only authenticates
   the Hooks Bridge HTTP endpoint between local CLI processes on the
   teammate's machine — it does NOT gate cloud Postgres writes. Cloud
   writes are gated by **the DATABASE_URL alone**, which is far worse:
   anyone with the connection string can write anything they want, role
   notwithstanding.

### What I propose (concrete redesign, not yet shipped)

**One-time-use signed invite tokens, generated by the admin in the web UI.**

```
admin opens /settings/team → "Invite a teammate" button
  → server action mints a token: { orgId, role, exp = now + 24h, jti }
    signed with the admin's Clerk session JWT
  → web shows a copyable URL: https://your-app/join?token=<jwt>
  → admin sends the URL via Slack DM / email / text. Anyone snooping
    the channel sees a URL, not raw credentials

teammate opens the URL
  → web calls /api/join?token=<jwt>
  → server validates: signature, exp, jti not seen before, orgId
    matches a real Clerk org
  → server provisions: row in `team_invites` (jti, orgId, role,
    used_at = now), row in Clerk org membership
  → server hands the teammate a one-shot bootstrap script:
      coodra team join \
        --invite-token <single-use-bootstrap> \
        --user-id <teammate's clerk user_id, derived>
  → teammate runs the script; CLI does the secret-exchange against
    a `/v1/team/bootstrap` endpoint on the cloud Postgres-fronted
    REST tier; receives a per-teammate scoped credential

on cloud Postgres
  → every write goes through Supabase RLS policies that check
    auth.jwt()->>'org_id' against the row's `org_id` AND
    auth.jwt()->>'role' against the operation
  → DATABASE_URL is no longer the universal write key; it's a fallback
    used only for the sync daemon's local-process trust boundary
```

This shifts auth from "shared bearer secret" to "per-user JWT with RLS",
which is what Supabase's auth model is designed for. Revocation =
disable that user's Clerk org membership; their JWT signature is still
valid but RLS checks `(auth.jwt()->>'org_id') IS NOT NULL AND <role>` and
their role goes from `member` to `null`.

### What I will land in the next pass

The above is a meaningful chunk of work — Clerk JWT + Supabase RLS + a new
join endpoint + token storage table + token revocation. As an interim
mitigation that lands in <1 day:

1. **Per-teammate hook secrets.** `team setup` generates a master secret;
   `team mint-invite --user-id <theirs>` derives a sub-secret =
   `HMAC-SHA256(master, user_id)` with a single-use token wrapping it.
   The teammate's `team join` validates the wrapping token against an
   `invite_tokens` cloud table.
2. **Time-limited invite URLs in the web UI.** `/settings/team` →
   "Invite a teammate" button → web mints a token, displays a
   copy-paste URL valid for 24h.
3. **Audit log for invite usage.** Each `team join` call writes a row
   to `team_invites_used` so you can see which secret was redeemed by
   whom + when.

Until that lands, the org-wide secret is the operating reality. Treat
it like an SSH private key — store in 1Password / Vault, share only via
end-to-end-encrypted channels, rotate when anyone leaves the team.

---

## 6. Admin's full linear flow

> Admin = the person who set up the team. The first one to run `team setup`.

### Day 0 · Bootstrap (one-time, ~5 minutes)

| # | Where | Action |
|---|---|---|
| 1 | **Web `/welcome`** | Click *Start team setup* — see the mode picker, confirm team |
| 2 | **Web `/onboarding/team` Step 1** | Read instructions, create your Supabase project, copy the Session-pooler URL (port 5432, NOT 6543) |
| 3 | **Web `/onboarding/team` Step 2** | Paste URL → page runs `SELECT 1` + 12-table schema probe. On a fresh project, schema is missing — that's expected |
| 4 | **Web `/onboarding/team` Step 3** | Read instructions, create Clerk app, enable Organizations, create your org. Note your `user_id`, `org_id`, publishable key, secret key |
| 5 | **CLI** | Run `coodra team setup --database-url ... --user-id ... --org-id ...`. CLI applies all 13 migrations, generates hook secret, writes `~/.coodra/config.json` + `.env` |
| 6 | **CLI** | Append the three Clerk env lines to `~/.coodra/.env` (publishable [×2 with NEXT_PUBLIC_ prefix and unprefixed], secret) |
| 7 | **Web `/onboarding/team` Step 5** | Wizard shows the credential block to share. Copy to 1Password / Bitwarden |

### Day 0 · First project setup (one-time per repo)

| # | Where | Action |
|---|---|---|
| 8 | **CLI** in your repo | `coodra init --project-slug my-app --ide claude`. Registers project locally, scaffolds an empty feature-pack dir, wires Claude Code hooks |
| 9 | **CLI** | `coodra start`. Spawns MCP :3100 + Hooks Bridge :3101 + Sync Daemon |
| 10 | **Web** any URL | Confirm the sidebar shows green "● Team workspace" + your org slug; dashboard eyebrow says "TEAM WORKSPACE" |

### Day 0 · Author the first feature

| # | Where | Action |
|---|---|---|
| 11 | **Web `/packs/new`** (or CLI `coodra feature add`) | Pick a template or start blank. Set `slug`, `description` (the trigger blurb agents see at session start), `whenNotToUse`, `maturity`, `owners`, `tags`. Draft the body |
| 12 | **Web `/packs/[slug]`** | Hit Save → server action writes `feature.md` to `docs/features/<slug>/` + writes the `feature_packs` row + enqueues sync_to_cloud |
| 13 | (Behind the scenes) | Sync daemon pushes the metadata row to cloud within ~1s. Every teammate's puller pulls metadata within 10s. **Important: today the teammate still needs `git pull` to get the actual file body — see §4 for the gap and fix** |

### Day 0 · Author the team's policy chain

| # | Where | Action |
|---|---|---|
| 14 | **Web `/policies`** | See the 25 default rules seeded by `init`. Add your own (deny `infra/**` writes, ask before `bash` in production paths). Each rule = agent_type + tool_name + verdict |
| 15 | **Web `/policies`** | Toggle inactive any rule that's too aggressive |

### Day 0 · Onboard the first teammate

| # | Where | Action |
|---|---|---|
| 16 | **Web `/settings/team`** → *Add another teammate* panel | The pre-formatted `coodra team join` snippet shows your org_id baked in |
| 17 | Out-of-band (1Password / signed channel) | Send teammate (DB URL, hook secret, both Clerk keys). **Hook secret is shown only at `team setup` time** — see §5 for redesign |
| 18 | (Wait) | Teammate runs `coodra team join`, `init`, `start`. Within 10 s of their first SessionStart you'll see their `created_by_user_id` show up under `/settings/team` → *Members observed locally* |

### Day 1+ · Daily product development

| Activity | Where | What you actually do |
|---|---|---|
| Open the IDE | (no coodra UI) | Open Claude Code in your repo. Bridge auto-fires SessionStart, agent gets feature INDEX + recent decisions injected |
| Make architectural choices | Agent calls `record_decision` | You see them appear on `/decisions` within ~10s |
| Pair with teammate | **Web `/decisions`** | Read what they decided, see "Decided by Alice" badges. Filter by project. Search before contradicting |
| Audit a denied write | **Web `/runs/[id]`** | Open the run, scroll events, find the deny verdict. Adjust policy if false positive |
| Pause an agent going off the rails | **Web `/kill-switches`** | Hit *Pause* on (project + agent_type). Bridge refuses every PreToolUse until resumed |
| Review the week | **Web `/`** dashboard | Active runs, allow/deny ratio, narrative coverage % (are agents calling save_context_pack?), decision capture % (are they calling record_decision?) |

### Anytime · Govern

| What | Where | Why |
|---|---|---|
| Rotate the hook secret | **CLI** `coodra team setup --database-url <same>` | If you suspect leak. Re-run setup with same URL → new secret. Teammates rerun `team join` with new secret to re-sync |
| Remove a teammate | Clerk dashboard (out of band) | Remove from your Clerk org; their next sign-in fails. Their LOCAL SQLite still has data — that's their machine |
| Rebuild the cloud schema | **CLI** `coodra team setup --database-url <new-url>` | Migrate to a different Postgres |

---

## 7. Member's full linear flow

> Member = anyone who joins after the admin set up the team.

### Day 0 · Join

| # | Where | Action |
|---|---|---|
| 1 | (Out of band) | Receive (DB URL, hook secret, Clerk keys) from your admin |
| 2 | (Out of band) | Sign in to Clerk; admin invites you to their Clerk org |
| 3 | **CLI** | `coodra team join --user-id user_YOURS --org-id org_THEIRS --secret ... --database-url ...`. Writes `~/.coodra/config.json` + `.env` |
| 4 | **CLI** | Append the same three Clerk env lines to `~/.coodra/.env` |
| 5 | **CLI** in your repo | `coodra init --project-slug ... --ide claude` |
| 6 | **CLI** | `coodra start`. Sync daemon's first puller tick (~2 s) pulls everything the team has decided so far into your local SQLite |

### Day 0 · Onboard yourself by reading

| Activity | Where | Why |
|---|---|---|
| Read what's been built | **Web `/context-packs`** | Last 100 session recaps, sorted recent. Read the most recent ones to learn what your teammates have shipped |
| Read what's been decided | **Web `/decisions`** | Filter by project. Each row shows "Decided by Alice" — you know who to ask |
| Look at the spec | **Web `/packs/<slug>`** | Each feature the admin authored. This is what your agent will see at SessionStart |
| Set the lay of the land | **Web `/`** dashboard | Active projects, allow rate, who's been most active |

### Day 1+ · Daily product development

| Activity | Where | What you actually do |
|---|---|---|
| Open the IDE | (no coodra UI) | Same as admin — Claude Code in your repo, bridge fires SessionStart |
| Agent reads context | Automatic | Bridge injects feature INDEX + recent decisions (last 7 days, this project) into agent's first turn |
| Agent loads a feature on demand | Automatic | When agent's planner decides, it calls `coodra__get_feature(slug)`; bridge returns feature.md body |
| Make architectural choices | Agent calls `record_decision` | Stamped with **your** Clerk user_id. Visible to teammates within ~10s |
| End of session | Agent calls `save_context_pack` | A narrative recap. Visible on `/context-packs` with your "Authored by" badge |
| Pause your own session | **Web `/kill-switches`** | Toggle for your project + agent_type. Bridge refuses PreToolUse until you resume |
| Avoid pausing teammates | RBAC blocks it | `assertCanResumeKillSwitch` only lets members resume switches they paused themselves |

### Anytime · Browse what the team is doing

| What | Where |
|---|---|
| Last 7 days of activity | **Web `/`** dashboard "Recent runs" + "Recent denies" |
| Single run's full transcript | **Web `/runs/[id]`** — every PreToolUse, PostToolUse, decision, the saved context pack |
| Cross-project decisions | **Web `/decisions`** — filter by project, by date |
| Cross-project session recaps | **Web `/context-packs`** — filter by project, by source (`agent` vs `bridge_auto`) |
| Codebase symbol graph | **Web `/graph`** — read-only Graphify visualization when present |
| Sync queue health (debugging) | **Web `/sync`** — pending vs picked vs dead jobs per queue |

---

## 8. Viewer's full linear flow

> Viewer = stakeholder, PM, designer, ops auditor, exec. Read-only.

| Activity | Where | What |
|---|---|---|
| Sign in | Clerk | Admin assigns you the custom `org:viewer` role in Clerk |
| Browse | **Web** any read-only URL | `/`, `/decisions`, `/context-packs`, `/runs`, `/packs`, `/policies`, `/kill-switches` (read views), `/settings/team` (read view) |
| Cannot do | — | No CLI access (you don't install). No agent sessions. No policy edits. No invites. The web's edit buttons are RBAC-rejected if clicked |

The viewer surface is **the same web app** — every page renders the same
content. The only difference is action buttons are either grayed out or
RBAC-rejected at the server-action boundary. *(Honest gap: web-v2's server
actions still need RBAC guards added — see §11.)*

---

## 9. Where each Coodra feature is accessed

This is the master cheat-sheet. Search this section when stuck on
"where do I do X?"

### Project lifecycle
| Action | Web | CLI |
|---|---|---|
| Create a project | `/init` | `coodra init` |
| List projects | `/projects` | `coodra project list` |
| One project's overview | `/projects/[slug]` | — |
| Rename / reset / delete a project | `/projects/[slug]` | `coodra project rename/reset/delete` |
| Switch which project you're in | Sidebar → project pill | (cd into that repo) |

### Features (the skill library)
| Action | Web | CLI |
|---|---|---|
| Browse all features | `/packs` (will become `/features`) | `coodra feature list` |
| Read one feature | `/packs/[slug]` | `cat docs/features/<slug>/feature.md` |
| Author from template | `/packs/new` | `coodra feature add <slug>` |
| Edit / save | `/packs/[slug]` (edit form) | edit files + `coodra feature index` |
| Pull team's features to your machine | (today: `git pull`) | (today: `git pull`) |
| Agent's lazy load | (auto on session start: INDEX) | — |
| Agent's full load | (auto on demand: `get_feature` MCP tool) | — |

### Decisions
| Action | Web | CLI |
|---|---|---|
| Browse all team decisions | `/decisions` | — |
| Filter by project | `/decisions?project=…` | — |
| Read one in run context | `/runs/[id]` | — |
| Record new (only via agent) | (via agent `record_decision` MCP tool) | — |

### Context packs (session recaps)
| Action | Web | CLI |
|---|---|---|
| Browse | `/context-packs` | — |
| Read one | `/context-packs/[id]` | — |
| Filter | `/context-packs?source=agent&project=…` | — |
| Save new | (via agent `save_context_pack` or bridge auto) | — |

### Runs / sessions
| Action | Web | CLI |
|---|---|---|
| Browse all runs | `/runs` | — |
| Single run drill-down | `/runs/[id]` | — |
| Cancel stuck `in_progress` runs | Dashboard *Cancel N stuck* | `coodra run cancel-stuck` |
| Tail logs | `/projects/[slug]` log streams | `coodra logs <service>` |

### Policies (governance — admin only)
| Action | Web | CLI | Roles |
|---|---|---|---|
| Browse rules | `/policies` | `coodra policy list` | all |
| Add a rule | `/policies` *Add rule* | `coodra policy add` | admin |
| Toggle active | `/policies` toggle | `coodra policy set-active` | admin |
| Delete a rule | `/policies` delete | `coodra policy delete` | admin |

### Kill switches
| Action | Web | CLI | Roles |
|---|---|---|---|
| List | `/kill-switches` | `coodra pause status` | all |
| Pause | `/kill-switches` *Pause* | `coodra pause` | member (own) / admin (any) |
| Resume | `/kill-switches` *Resume* | `coodra resume` | member (own) / admin (any) |

### Sync queue (debugging)
| Action | Web | CLI |
|---|---|---|
| Queue depth + dead-letter | `/sync` | `coodra doctor` checks 25/26/27 |
| Retry a dead job | `/sync` *Retry* | `coodra cloud-migrate retry` |

### Workspace + diagnostics
| Action | Web | CLI |
|---|---|---|
| Service status | `/workspace` | `coodra status` |
| Doctor diagnostic | (run from CLI) | `coodra doctor` |
| Start / stop services | Topbar *coodra start* | `coodra start` / `stop` |
| Tail any service log | `/workspace` log panel | `coodra logs <service>` |

### Settings
| Action | Web | CLI |
|---|---|---|
| Workspace defaults (mode, ports, log level) | `/settings/workspace` | edit `~/.coodra/.env` |
| Team config + members | `/settings/team` (team mode only; 404s in solo) | `cat ~/.coodra/config.json` |
| Reconfigure team | `/onboarding/team` (re-runnable) | `coodra team setup --database-url <same>` |
| Leave team | (no UI) | `coodra team leave` |

### Onboarding
| Action | Web | CLI |
|---|---|---|
| First-run mode picker | `/welcome` | — |
| Solo confirm + next steps | `/onboarding/solo` | `coodra init` |
| Full team-mode wizard | `/onboarding/team` | `coodra team setup` (or `team join` for teammates) |

---

## 10. The full picture as one timeline

A real two-person Monday-Tuesday:

```
MONDAY
─────────────────────────────────────────────────────────────────
09:00  Admin creates Supabase + Clerk projects                  Web /onboarding/team Step 1-3
09:05  Admin runs `coodra team setup`                        CLI
09:10  Admin runs `coodra init` in apps/payments             CLI
09:12  Admin runs `coodra start`                             CLI
09:15  Admin authors feature "stripe-payments"                  Web /packs/new
       (writes docs/features/stripe-payments/feature.md +
        a few supporting files; commits to git)
09:20  Admin opens Claude Code → first agent session            (IDE)
09:21  Bridge fires SessionStart → injects feature INDEX        (auto)
09:22  Agent's planner decides "stripe-payments" is relevant
       → MCP get_feature(stripe-payments)                       (auto)
09:30  Agent records 4 decisions over 30 minutes                MCP record_decision
09:50  Agent saves context pack "stripe webhook handler done"    MCP save_context_pack
       Cloud now has: 1 project, 1 run, 4 decisions, 1 context pack
       — all stamped admin's user_id. Feature metadata also synced;
       feature.md travels via git when admin commits.

12:00  Admin sends Member the credential block                  Out-of-band (1Password)
12:02  Member git-clones the repo                               git clone
12:05  Member runs `coodra team join`                        CLI on member's machine
12:08  Member's first puller tick pulls cloud → local           (auto, ~10s)
       Member's local now has admin's project, run, 4 decisions, context pack
       AND knows about "stripe-payments" feature (metadata only — body
       arrived via the git clone)
12:10  Member opens web app → reads /decisions to catch up      Web /decisions
       Sees "Decided by Alice" on every row

14:00  Member runs `coodra init` in apps/auth                CLI
14:05  Member opens Claude Code → first agent session           (IDE)
14:06  Bridge fires SessionStart → no feature for apps/auth     (auto, INDEX is empty for this project)
14:30  Member records 6 decisions for the auth module           MCP record_decision
       Cloud now has: 2 projects, 2 runs, 10 decisions, 1 context pack
       Within 10s, admin's local pulls member's 6 decisions

16:00  Admin checks dashboard                                   Web /
       "● Team workspace · v2-clean-team" with 2 active runs,
       10 decisions today (4 by them, 6 by member), member appears
       in /settings/team Members table

TUESDAY
─────────────────────────────────────────────────────────────────
09:30  Admin authors feature "auth-clerk-oauth"                 Web /packs/new
       (commits to git; Member git pulls)
09:35  Cloud row appears; member's puller pulls metadata 10s later
09:40  Member starts new agent session in apps/auth             (IDE)
09:41  Bridge fires SessionStart → injects feature INDEX with
       both stripe-payments AND auth-clerk-oauth                (auto)
09:42  Member's agent decides auth-clerk-oauth is relevant for
       this prompt → MCP get_feature(auth-clerk-oauth)          (auto)
       Member's agent now has admin's spec at turn zero, even
       though admin and member never spoke about it directly today
       — that's the team-mode unlock.
```

Read that timeline a second time. **No part of the value shows up only in
the CLI or only in the web app**:

- The CLI handles installs / starts / migrations / one-shot agent sessions.
- The web app handles authoring / browsing / governance / member visibility.
- The agent (Claude Code) does the work, reading features and decisions
  from the bridge + writing decisions and packs back.
- Sync daemons quietly mirror everything in the background.

You need all four for team mode to deliver. Solo mode hides this because
your local SQLite is doing all the cross-machine jobs simultaneously
(there's no other machine).

---

## 11. What's there vs what still needs work

### Fully working today (verified end-to-end against your real Supabase)
- ✓ `coodra team setup` against any Supabase URL — applies all 13 migrations, generates hook secret, writes config + .env
- ✓ `coodra init` in a repo (project + 25 default policy rules + Claude hook entries + sync_to_cloud enqueue)
- ✓ `coodra start` (all 3 daemons, team mode)
- ✓ SessionStart hook → bridge fires + creates run row stamped with caller's user_id
- ✓ MCP `record_decision` (stdio + http) → local SQLite + sync to cloud, both with user_id
- ✓ `coodra team join` for a second member, hook secret matches admin's
- ✓ Bidirectional sync — admin's writes pulled by member's puller, member's writes pulled by admin's puller, ~10s in either direction
- ✓ Web-v2 mode-aware layout — solo and team workspaces look distinctly different (sidebar header, dashboard hero, nav groups)
- ✓ Web-v2 `/onboarding/team` 5-step wizard with real verify against Supabase
- ✓ Web-v2 `/decisions` with "Decided by" column ("You" for self / `user_…` for teammates)
- ✓ Web-v2 `/context-packs` with "Authored by" column
- ✓ Web-v2 `/settings/team` with org info + members observed locally (postgres-side query for cross-team)
- ✓ Web-v2 `/welcome` mode picker
- ✓ Web-v2 read paths for `/policies`, `/kill-switches`, `/packs`, `/runs`, `/projects`, `/workspace`, `/sync`, `/templates`
- ✓ Web-v2 server actions wired for: policies (add/delete/toggle), kill-switches (pause/resume), packs (save/upload/regenerate/delete), projects (rename/reset/delete), services (start/stop), runs (cancel-stuck), sync (retry-dead-job)

### Partial — code paths exist but UI or RBAC missing
- ⚠ **Web-v2 RBAC enforcement on server actions.** Role machinery exists in `packages/shared/src/auth/roles.ts`. Web actions don't yet call `requireRole(actor, 'admin')` before edits. Viewers signed into the web could currently invoke an action that should be denied. MCP tool handlers DO enforce; web doesn't. Fix: ~30 lines spread across `apps/web-v2/lib/actions/*.ts`.
- ⚠ **Member-list is "observed locally" only.** `/settings/team` lists every user_id we've seen write a row. Doesn't list Clerk-org members who haven't yet authored anything. Fix: add `clerkClient.organizations.getOrganizationMembershipList` call, union with locally-observed.
- ⚠ **Display names.** Members show as `user_2nKj…XYZ` instead of "Alice Smith". Fix: same Clerk-SDK call as above caches the user→name map; `<ActorBadge>` already accepts `displayName`.
- ⚠ **Feature content distribution.** Today metadata syncs (slug, checksum) but `feature.md` content travels via git. Members forget to `git pull`, miss new features. Fix: `feature_files` table or Supabase Storage bucket scoped per-org; `get_feature` reads from cloud when local is stale.
- ⚠ **Clerk web sign-in not wired in v2.** Original `apps/web` had `/auth/sign-in`, `/auth/sign-up`, `clerkMiddleware`. v2 has none. Without this, team-mode web is "view-only as the env-configured user". Fix: port the three files + add ClerkProvider in `app/layout.tsx`.
- ⚠ **Invite security as described in §5.** Today: shared org-wide secret, no expiry, no revocation, plaintext sharing. Fix: per-teammate JWTs + Supabase RLS as designed in §5.

### Aspirational — design exists, code doesn't
- ⨯ **Migration view for solo→team conversion.** `coodra team migrate` works in CLI; web has no progress UI. Admin running migration runs blind today.
- ⨯ **Cross-team feed filtering UI.** `/decisions` and `/context-packs` data carries user_id but no "filter by member" select dropdown.
- ⨯ **Real-time updates.** Web pages are server-rendered with `force-dynamic`. No SSE/WebSocket pushing live updates as decisions land. You refresh to see your teammate's just-recorded decision.
- ⨯ **Sync health card on dashboard.** Data exists (`fetchSyncSnapshot`); dashboard doesn't render it.

### A 1-day cleanup pass would deliver
1. Port Clerk middleware + `/auth/sign-in` + `/auth/sign-up` from `apps/web` to `apps/web-v2`. Real Clerk sign-in.
2. Add `requireRole` to every web action. Real RBAC enforcement.
3. Add Clerk SDK member lookup → display names + full org roster on `/settings/team`.
4. Add member-filter dropdown to `/decisions` + `/context-packs`.
5. Render the sync-health card on the dashboard.

That's the "demo-ready → ship-ready for a real second teammate" delta.

### A 1-week pass would deliver
6. Feature content cloud storage (Supabase Storage bucket; `get_feature` reads cloud when local stale; `pack save` server action uploads).
7. Per-teammate invite tokens + Supabase RLS as designed in §5.
8. Migration view in the web for solo→team conversion progress.

---

## 12. The self-hosted reality — answers to "but how does ___ get in?"

> Coodra is **MIT, fully self-hosted, BYO-everything**. There is **no
> Coodra-operated service** anywhere in the picture. No team
> directory. No SaaS auth. No central registry. This section answers
> the questions that exposes.

### 12.1 What "team identity" actually means

A team is the tuple **(your Postgres URL, your Clerk org_id)**. Anyone
holding both — *plus* membership in the Clerk org — is part of the team.
There is nothing global to look up. Nothing to register. Nothing
Coodra could lose for you because we never had it.

This is by design. The trade is concrete: you own your data and your
auth completely; you also own the cost of safe credential storage.

### 12.2 How each role gets onto a new machine

The flow is **the same for all three roles** — what differs is what
their Clerk role lets them do once connected, not how they connect.

| Scenario | What they do |
|---|---|
| Admin set up the team on Machine A. Now opens Machine B. | Open `/onboarding/team/join` (or run `coodra team join`). Paste the credential bundle. Done. Their Clerk role (`org:admin`) is unchanged — same admin, just on a different laptop. |
| New member onboarding | Receive bundle from admin via 1Password. Paste into `/onboarding/team/join`. Same form, same outcome. Their Clerk role is `org:basic_member`. |
| Viewer (PM, exec, designer) | If their team runs the *team-hosted shared web* deployment pattern (§12.5), they don't install anything — open the team's web URL, sign in via Clerk, the deployment scopes everything to their org_id and gates writes by their role. If they want a local copy of the dashboards, they paste the bundle just like a member. |
| Anyone who lost their config | Re-paste the bundle. The form overwrites local config. No "recover" flow needed because the bundle IS the recovery key. |

### 12.3 The Clerk integration model

**Each team brings their own Clerk app and their own organization.** Coodra
ships zero Clerk credentials, runs zero Clerk webhook endpoints, and operates
zero Clerk dashboards. Everything Clerk-related happens against the team's own
project at `dashboard.clerk.com`.

What this means concretely:

- **The team's Clerk app handles sign-in.** When a user opens the web app
  (whether locally on their laptop or at the team's hosted URL), Clerk's
  middleware redirects them to *the team's* sign-in page hosted at
  `*.accounts.dev` (Clerk dev) or the team's custom domain. Sign-in goes
  through the team's user pool.
- **Org membership = team membership.** A user is in the team iff Clerk says
  they're a member of the org. Removal = revoke org membership in Clerk.
- **Role mapping:** Clerk's built-in `org:admin` and `org:basic_member` plus a
  custom `org:viewer` role the admin creates. Mapping table in
  `packages/shared/src/auth/roles.ts` (`parseClerkRole`).
- **No Coodra Clerk app.** There's nothing to "log into Coodra" with.
  You log into your team's Clerk app.

### 12.4 What auth does a user need to log into the team workspace?

Two distinct credentials, used for different layers:

| Credential | What it gates | Stored where |
|---|---|---|
| Clerk session JWT (signed by team's Clerk app) | Web-app reads + writes (`/decisions`, `/policies`, server actions). Browser cookie after sign-in. | Browser local storage / cookies |
| Local hook secret (in `~/.coodra/.env`) | Local CLI process ↔ local Hooks Bridge HTTP handshake on `127.0.0.1:3101`. Never leaves the machine. | `~/.coodra/.env::LOCAL_HOOK_SECRET` |

The web app's per-developer-local pattern uses the local config (no Clerk
sign-in required because there's only one user on the machine — the env IS
the actor). The team-hosted pattern (§12.5) uses Clerk JWT for every visitor.

### 12.5 The two deployment patterns, again

This is the clarification that resolves your "is it globally recognized?"
question.

| Pattern | Who runs it | Auth model | Use case |
|---|---|---|---|
| **Per-developer local** (today's default) | Each developer, on their own laptop | Local env file IS the actor; no Clerk sign-in flow needed at the page level | Developers who want a personal copy of the dashboards |
| **Team-hosted shared** | Operator, on a team server (Vercel / Railway / Fly / a VPS) | Clerk middleware on every request; org membership scopes data; role gates writes | PMs, viewers, the org's audit dashboard |

In the team-hosted pattern, the server runs the same web app codebase but with
deployment env vars (DATABASE_URL + Clerk keys) instead of reading
`~/.coodra/.env`. Visitors hit the team's URL — `https://coodra.acme.com`
or `https://acme-coodra.vercel.app` — sign in via Clerk, and the web reads
their session.

The "global recognition" you asked about IS this URL. Anyone with the URL +
membership in the org's Clerk app can sign in. Nobody else can. There's no
discovery; the URL is the address.

The v2 web app today supports the per-developer local pattern fully and the
team-hosted pattern partially (queries are already org-scoped, but the Clerk
middleware + sign-in pages need to be ported from the original `apps/web` —
gap-listed in §11).

### 12.6 The machine-recovery flow, end-to-end

This is the worked example for "admin lost his laptop, has a new one, has the
1Password bundle":

```
1. Open the team's web URL (or http://localhost:3001 if running locally).
2. /welcome shows "● Connect to existing team" as one of three cards.
3. Click → /onboarding/team/join.
4. Paste 5 fields:
     - Database URL          (from 1Password)
     - Your Clerk user id    (from your Clerk profile)
     - The team's org id     (from 1Password)
     - Org slug              (optional, for nicer sidebar label)
     - Hook secret           (from 1Password)
5. Form runs SELECT 1 + table count against your Postgres.
6. On success, web action calls upgradeToTeamConfig + writeTeamHomeEnv.
7. Redirect to / with `?joined=ok&org=...`. Dashboard banner confirms.
8. Append Clerk keys (3 lines) to ~/.coodra/.env. Manual today.
9. cd into your project, run `coodra start`.
10. You're back. Same role, same data, same teammates.
```

Total elapsed: ~1 minute if you have the 1Password bundle.
Total elapsed: undefined if you don't. **The bundle is the only recovery key.**

### 12.7 What the next iteration will improve

- **Bundle-as-URL** — admin pastes from `/settings/team` "Generate invite URL",
  gets a single signed URL that bundles all 5 fields + a Clerk-org join link
  in one click for the teammate.
- **Per-teammate scoping** — replace the org-wide hook secret with per-teammate
  JWTs + Supabase RLS, so removal is "revoke this teammate's JWT" without
  rotating everyone else's.
- **Team-hosted Clerk middleware** — port the `clerkMiddleware` + `/auth/sign-in`
  pages from `apps/web` into v2 so a team can deploy the web app at their own
  URL and have visitors sign in.

Until these land, the machine-recovery flow above is the operating reality.

---

## 13. Identity — born, stored, retrieved, used, revoked

> If you read only one section, read this one. It traces a single user
> end-to-end so you know exactly where their identity lives at every
> moment.

### 13.1 The two-line summary

**Identity is a Clerk-minted `user_id` that gets baked into
`~/.coodra/config.json` on each machine and stamped on every cloud
Postgres row via `created_by_user_id`. The web app reads identity from
the local config (per-developer pattern) or from a Clerk session
(team-hosted pattern). Clerk is the only layer where cryptographic
verification happens.**

### 13.2 Stage-by-stage trace (one user, end-to-end)

| Stage | Where it happens | What's stored | Who consumes it |
|---|---|---|---|
| **1 · Born** | `dashboard.clerk.com` (Clerk-side) | Clerk database mints `user_2nKj…` (user) and `org_2nKj…` (org) | Clerk only — Coodra never sees the creation event |
| **2 · Bound to laptop** | `coodra team setup --user-id …` writes two files | `~/.coodra/config.json::team.clerkUserId`, `clerkOrgId`. Same fields in `~/.coodra/.env::COODRA_TEAM_ORG_ID` | Daemons at boot, web app at request time |
| **3 · Daemons read at boot** | `apps/mcp-server/src/lib/actor-identity.ts::getActorIdentity()` and the hooks-bridge mirror | Held in process memory of each daemon | Tool-handler code paths that need to stamp writes |
| **4 · Stamped on every write** | MCP handler line `createdByUserId: actor.userId` (`apps/mcp-server/src/tools/record-decision/handler.ts:218`, plus `save_context_pack`, kill-switch pause/resume, etc.) | Local SQLite `decisions.created_by_user_id`, then synced to cloud Postgres `decisions.created_by_user_id` | Web app's "Decided by" / "Authored by" badges; future RLS policies; audit log queries |
| **5 · Web reads viewer identity** | `apps/web-v2/lib/auth.ts::getActor()` — branches on mode | (a) per-dev local: read from `~/.coodra/config.json` via `readTeamConfig()`. (b) team-hosted: read from Clerk JWT via `auth()` from `@clerk/nextjs/server` | Layout passes `viewerUserId` to every page; ActorBadge compares per row |
| **6 · Compared per row** | `apps/web-v2/components/ActorBadge.tsx` | `isYou = viewerUserId === row.createdByUserId` | Renders "You" / `user_…` badge |
| **7 · Verification** | (a) per-dev: NONE — local file is the truth. (b) team-hosted: Clerk middleware verifies JWT signature against Clerk's public key + checks org membership | — | Gates web reads + writes; tool calls trust the local config |
| **8 · Revocation** | (a) per-dev: rotate hook secret in `team setup`, distribute new value out-of-band. (b) team-hosted: admin removes user from Clerk org → next sign-in fails. Existing rows in audit tables stay attributed to the removed user (append-only, ADR-007) | — | — |

### 13.3 Where each piece of identity physically lives

```
┌──────────────────────────────────────────────────────────────────┐
│ Clerk (the team's own Clerk app, dashboard.clerk.com)            │
│   - The mint of `user_…` and `org_…` strings.                    │
│   - The signing key for JWTs.                                    │
│   - The org-membership table.                                    │
│   Coodra never holds the signing key. We only verify          │
│   signatures with the publishable key.                           │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Each user's laptop (~/.coodra/)                               │
│   config.json::team.clerkUserId   ← "user_2nKj…"                 │
│   config.json::team.clerkOrgId    ← "org_2nKj…"                  │
│   .env::COODRA_TEAM_ORG_ID     ← "org_2nKj…"                  │
│   Read at daemon boot + every tool call. Trusted unverified —    │
│   the file IS the source of truth on this machine.               │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ The team's Postgres (your Supabase project)                      │
│   Every row in 5 tables (runs, decisions, context_packs,         │
│   policies, feature_packs) carries:                              │
│     created_by_user_id   text                                    │
│     org_id (on projects only) text                               │
│   Append-only. Never updated. Never deleted.                     │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Web app at render time                                           │
│   Per-developer pattern: reads ~/.coodra/config.json,         │
│     trusts the user_id named there.                              │
│   Team-hosted pattern: reads the Clerk session cookie,           │
│     verifies the JWT, gets the real user_id from there.          │
│   Either way: compares viewerUserId to row.createdByUserId       │
│     for the "You" badge.                                         │
└──────────────────────────────────────────────────────────────────┘
```

### 13.4 The one place verification ACTUALLY happens

In the per-developer pattern, **nothing is verified**. If you copy someone's
`~/.coodra/.env` to your machine, you become them as far as Coodra is
concerned. The trust boundary is "this is my laptop and only I have access
to my files." That's a real boundary — your laptop's filesystem
permissions — but it's not cryptographic.

In the team-hosted pattern, **Clerk verifies every web request** via
JWT signature. The middleware reads the cookie, asks Clerk's public key
"is this signature valid? does it belong to a user in this org? is it not
expired?" If any answer is no, it sends them to /auth/sign-in.

This is why the team-hosted pattern is the right choice for non-developers
(viewers, PMs, execs): you can hand them a URL and a Clerk login, and the
sign-in is real.

### 13.5 What the local hook secret IS and ISN'T

To pre-empt confusion: `LOCAL_HOOK_SECRET` is **not** user identity. It's
a machine-local trust token. Its only job is:

```
CLI process on Alice's laptop ────HTTP POST 127.0.0.1:3101───→ Hooks Bridge on Alice's laptop
                                  X-Local-Hook-Secret: <hex>
```

The bridge compares the header to `~/.coodra/.env::LOCAL_HOOK_SECRET`.
If mismatch, 403. That's it.

It's shared across the team because every teammate's bridge needs to trust
their own teammates' CLI processes when those processes connect to a
shared cloud DB. But it never gates web sign-in. Web sign-in is Clerk's job.

### 13.6 The questions you should be able to answer after reading this

| Question | Answer |
|---|---|
| Where does Alice's user_id come from? | Clerk minted it when she signed up |
| Where does the system *store* her user_id? | (a) Clerk's database — Clerk's copy. (b) `~/.coodra/config.json` on each laptop she uses — local copy. (c) Inside every audit row she writes — historical copy |
| When she runs `record_decision`, how is her id attached? | MCP handler calls `getActorIdentity()` which reads `~/.coodra/config.json`; the user_id is set as `created_by_user_id` on the inserted row |
| When Bob opens the web and sees Alice's decision, how does the page know it was hers? | The row's `created_by_user_id` says so |
| When Bob sees "You" on his own decision, how is that decided? | `getActor()` returns Bob's id; ActorBadge compares; match → "You" |
| Can Alice impersonate Bob in her local config? | Yes — and her writes would land as Bob on cloud. The trust boundary is "her laptop." Cryptographic verification only happens at Clerk web sign-in (Pattern B) |
| What stops a stranger from reading the cloud DB directly? | Postgres credentials (`DATABASE_URL`). Whoever has the URL has full read+write. The next-iteration RLS policies (§5) move this to Clerk-JWT-gated row-level security |
| What does removing someone from the team look like? | Admin removes them from Clerk org. Their next sign-in fails. Their existing audit rows stay because the audit is append-only |

---

## 14. The shortest possible explanation

> **Every architectural decision your team's AI agents make is captured,
> attributed to who made it, mirrored across everyone's machines, and
> automatically read by the next session — so two engineers building the
> same feature on different days don't silently contradict each other.**

The web app is how you author + browse it. The CLI is how you set it up
+ run the daemons. Claude Code (or Cursor / Windsurf) is what actually
does the work and writes the audit history. Sync daemons mirror
everything in the background.
